"""Graph Studio renderer (PLAN_PHASE3.md §4): one JSON figure spec -> a publication figure with matplotlib.

The same function draws the preview and every export, so the preview is exactly the file that is downloaded.
Formats: png, jpg, tiff, webp (raster at the chosen DPI), svg, pdf, eps, ps (vector; TrueType fonts embedded as Type 42,
SVG text kept as text). No pyplot: every figure is its own Figure object, rendered under a lock.

Spec: {name, kind: line|scatter|bar|stack|heatmap|corrmatrix, series: [{name, x, y, yerr?, axis: left|right, color,
linestyle, linewidth, marker, markersize, show_line, show_markers}], map: {x0, dx, nx, y0, dy, ny, v}, matrix: {labels,
values}, fit: {type: none|linear|poly2|power|exp, show_eq}, band: [x0, x1], band_label, smooth: n, style: {...}}.
"""
import csv
import io
import json
import math
import re
import threading
import time
import zipfile

import numpy as np
from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import Response

import matplotlib
matplotlib.use("Agg")
from matplotlib.figure import Figure  # noqa: E402
import matplotlib.ticker  # noqa: E402
from matplotlib.ticker import AutoMinorLocator  # noqa: E402

router = APIRouter(prefix="/api/figures", tags=["figures"])
_lock = threading.Lock()
FORMATS = {"png": "image/png", "jpg": "image/jpeg", "tiff": "image/tiff", "webp": "image/webp", "svg": "image/svg+xml",
           "pdf": "application/pdf", "eps": "application/postscript", "ps": "application/postscript"}
PALETTES = {
    "default": ["#1f5fa8", "#d1495b", "#2e9e5b", "#e29a2d", "#7b4fa0", "#1b9aaa", "#8c564b", "#c0398f", "#5f6b73", "#a5a52b"],
    "okabe-ito": ["#0072B2", "#D55E00", "#009E73", "#E69F00", "#56B4E9", "#CC79A7", "#F0E442", "#000000"],
    "grayscale": ["#000000", "#555555", "#888888", "#aaaaaa", "#333333", "#777777"],
    "viridis": ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725", "#31688e"],
    "tableau": ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"],
}
FONTS = {"serif": ["Times New Roman", "DejaVu Serif"], "sans": ["Arial", "Helvetica", "DejaVu Sans"],
         "dejavu": ["DejaVu Sans"], "mono": ["Consolas", "DejaVu Sans Mono"], "times": ["Times New Roman", "DejaVu Serif"],
         "arial": ["Arial", "DejaVu Sans"], "calibri": ["Calibri", "DejaVu Sans"], "cambria": ["Cambria", "DejaVu Serif"]}
STYLE = dict(title="", title_size=None, title_bold=True, xlabel="", ylabel="", y2label="", font_family="sans", font_size=10,
             tick_size=None, legend_size=None, grid_major=True, grid_minor=False, grid_style="-", grid_alpha=0.35, grid_width=0.6,
             minor_ticks=True, tick_dir="in", ticks_all_sides=True, frame="box", xlim=None, ylim=None, y2lim=None, logx=False,
             logy=False, invert_x=False, invert_y=False, legend=True, legend_loc="best", legend_frame=False, legend_cols=1,
             palette="default", width_mm=90.0, height_mm=70.0, dpi=300, background="white", cmap="viridis", clim=None,
             cbar_label="", annotation="", line_width=1.5, marker_size=4.0, axis_width=0.8, aspect="auto", show_values=True)


def _arr(v):
    return np.array([np.nan if x is None else x for x in (v or [])], dtype=np.float64)


def _smooth(y, n):
    n = int(n or 0)
    if n < 2 or len(y) < n:
        return y
    k = np.ones(n)
    ok = np.isfinite(y)
    s = np.convolve(np.where(ok, y, 0.0), k, "same")
    c = np.convolve(ok.astype(float), k, "same")
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(c > 0, s / c, np.nan)


def fit(x, y, kind):
    """(x_line, y_line, equation, R², Pearson r, Spearman ρ) or None."""
    ok = np.isfinite(x) & np.isfinite(y)
    x, y = x[ok], y[ok]
    if len(x) < 3 or np.ptp(x) == 0:
        return None
    xs = np.linspace(x.min(), x.max(), 200)
    if kind == "linear":
        b, a = np.polyfit(x, y, 1)
        yp, ys, eq = a + b * x, a + b * xs, f"y = {b:.4g}·x {'+' if a >= 0 else '−'} {abs(a):.4g}"
    elif kind == "poly2":
        c2, c1, c0 = np.polyfit(x, y, 2)
        yp, ys, eq = np.polyval([c2, c1, c0], x), np.polyval([c2, c1, c0], xs), f"y = {c2:.4g}·x² + {c1:.4g}·x + {c0:.4g}"
    elif kind == "power":
        m = (x > 0) & (y > 0)
        if m.sum() < 3:
            return None
        b, la = np.polyfit(np.log(x[m]), np.log(y[m]), 1)
        a = math.exp(la)
        xs = np.linspace(x[m].min(), x[m].max(), 200)
        yp, ys, eq = a * np.where(x > 0, x, np.nan) ** b, a * xs ** b, f"y = {a:.4g}·x^{b:.4g}"
    elif kind == "exp":
        m = y > 0
        if m.sum() < 3:
            return None
        b, la = np.polyfit(x[m], np.log(y[m]), 1)
        a = math.exp(la)
        yp, ys, eq = a * np.exp(b * x), a * np.exp(b * xs), f"y = {a:.4g}·exp({b:.4g}·x)"
    else:
        return None
    okp = np.isfinite(yp)
    ss = ((y[okp] - yp[okp]) ** 2).sum()
    st = ((y[okp] - y[okp].mean()) ** 2).sum()
    r2 = 1 - ss / st if st > 0 else float("nan")
    pr = float(np.corrcoef(x, y)[0, 1]) if np.std(y) > 0 else float("nan")
    rk = lambda v: np.argsort(np.argsort(v))
    sr = float(np.corrcoef(rk(x), rk(y))[0, 1]) if np.std(y) > 0 else float("nan")
    return xs, ys, eq, r2, pr, sr


def _style(spec):
    s = dict(STYLE)
    s.update({k: v for k, v in (spec.get("style") or {}).items() if k in STYLE})
    return s


def draw(spec):
    """The matplotlib Figure for a spec."""
    s = _style(spec)
    kind = spec.get("kind", "line")
    W, H = max(20.0, float(s["width_mm"])) / 25.4, max(20.0, float(s["height_mm"])) / 25.4
    fig = Figure(figsize=(W, H), dpi=int(s["dpi"]), layout="constrained")
    bg = s["background"]
    fig.patch.set_facecolor("none" if bg == "transparent" else bg)
    fs = float(s["font_size"])
    ts, ls_ = float(s["tick_size"] or fs * 0.9), float(s["legend_size"] or fs * 0.85)
    fam = FONTS.get(s["font_family"], [s["font_family"], "DejaVu Sans"])
    rc = {"font.family": "sans-serif" if s["font_family"] not in ("serif", "times", "cambria") else "serif",
          "font.sans-serif": fam, "font.serif": fam, "font.size": fs, "mathtext.fontset": "dejavuserif" if s["font_family"] in ("serif", "times") else "dejavusans",
          "axes.linewidth": s["axis_width"], "xtick.direction": s["tick_dir"], "ytick.direction": s["tick_dir"]}
    with matplotlib.rc_context(rc):
        ax = fig.add_subplot(111)
        ax.set_facecolor("none" if bg == "transparent" else bg)
        pal = PALETTES.get(s["palette"], PALETTES["default"])
        ax2 = None
        handles = []
        if kind == "heatmap":
            m = spec.get("map") or {}
            v = _arr(m.get("v")).reshape(int(m["ny"]), int(m["nx"]))
            ext = [m["x0"], m["x0"] + m["nx"] * m["dx"], m["y0"], m["y0"] + m["ny"] * m["dy"]]
            cl = s["clim"] or [None, None]
            im = ax.imshow(np.ma.masked_invalid(v), origin="lower", extent=ext, cmap=s["cmap"], vmin=cl[0], vmax=cl[1],
                           aspect="equal" if s["aspect"] in ("auto", "equal") else s["aspect"], interpolation="nearest")
            cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.03)
            cb.set_label(s["cbar_label"] or m.get("label", ""), fontsize=fs)
            cb.ax.tick_params(labelsize=ts)
        elif kind == "corrmatrix":
            mx = spec.get("matrix") or {}
            labels, vals = mx.get("labels", []), np.array([[np.nan if c is None else c for c in r] for r in mx.get("values", [])], dtype=float)
            im = ax.imshow(np.ma.masked_invalid(vals), cmap=s["cmap"] if s["cmap"] != "viridis" else "RdBu_r", vmin=-1, vmax=1)
            ax.set_xticks(range(len(labels)), labels, rotation=60, ha="right", fontsize=ts)
            ax.set_yticks(range(len(labels)), labels, fontsize=ts)
            if s["show_values"] and len(labels) <= 25:
                for i in range(len(labels)):
                    for j in range(len(labels)):
                        if np.isfinite(vals[i, j]):
                            ax.text(j, i, f"{vals[i, j]:.2f}", ha="center", va="center", fontsize=max(5, ts * 0.7),
                                    color="white" if abs(vals[i, j]) > 0.6 else "black")
            cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.03)
            cb.set_label(s["cbar_label"] or "Pearson r", fontsize=fs)
        else:
            series = spec.get("series") or []
            stack_base = None
            nb = sum(1 for se in series if (se.get("type") or kind) == "bar")
            bi = 0
            for i, se in enumerate(series):
                x, y = _arr(se.get("x")), _arr(se.get("y"))
                if not len(x):
                    continue
                y = _smooth(y, spec.get("smooth"))
                a = ax
                if se.get("axis") == "right":
                    ax2 = ax2 or ax.twinx()
                    a = ax2
                col = se.get("color") or pal[i % len(pal)]
                lw = float(se.get("linewidth") or s["line_width"])
                ms = float(se.get("markersize") or s["marker_size"])
                lab = se.get("name") or f"series {i + 1}"
                t = se.get("type") or kind
                if t == "bar":
                    w = (np.min(np.diff(np.unique(x))) if len(np.unique(x)) > 1 else 1.0) * 0.8 / max(nb, 1)
                    h = a.bar(x + (bi - (nb - 1) / 2) * w, y, width=w, color=col, label=lab, yerr=_arr(se.get("yerr")) if se.get("yerr") else None,
                              capsize=2, edgecolor="black", linewidth=0.4)
                    bi += 1
                elif t == "stack":
                    base = np.zeros_like(y) if stack_base is None else stack_base
                    h = a.fill_between(x, base, base + np.nan_to_num(y), color=col, alpha=0.85, label=lab, linewidth=0)
                    stack_base = base + np.nan_to_num(y)
                else:
                    show_line = se.get("show_line", t != "scatter")
                    show_mk = se.get("show_markers", t == "scatter")
                    mk = se.get("marker") or ("o" if show_mk else None)
                    h, = a.plot(x, y, color=col, lw=lw if show_line else 0, ls=se.get("linestyle") or "-", marker=mk if show_mk else None,
                                ms=ms, label=lab, mfc=se.get("mfc") or col, mec=col)
                    if se.get("yerr"):
                        e = _smooth(_arr(se["yerr"]), spec.get("smooth"))
                        if se.get("err_style") == "bars":
                            a.errorbar(x, y, yerr=e, fmt="none", ecolor=col, elinewidth=lw * 0.6, capsize=2)
                        else:
                            a.fill_between(x, y - e, y + e, color=col, alpha=0.18, linewidth=0)
                handles.append(h)
                if i == 0 and (spec.get("fit") or {}).get("type", "none") != "none":
                    f = fit(x, y, spec["fit"]["type"])
                    if f:
                        xs, ys, eq, r2, pr, sr = f
                        hf, = a.plot(xs, ys, color=spec["fit"].get("color") or "#222222", lw=lw * 0.9, ls="--", label="fit")
                        handles.append(hf)
                        if spec["fit"].get("show_eq", True):
                            a.text(0.03, 0.97, f"{eq}\nR² = {r2:.4f}   r = {pr:.3f}   ρ = {sr:.3f}", transform=a.transAxes, va="top", ha="left",
                                   fontsize=ls_, bbox=dict(boxstyle="round,pad=0.3", fc="white", ec="#999999", lw=0.5, alpha=0.85))
            if spec.get("xticklabels"):
                labs = [str(v) for v in spec["xticklabels"]]
                ax.set_xticks(range(len(labs)), labs, rotation=30 if max(map(len, labs), default=0) > 8 else 0, ha="right" if max(map(len, labs), default=0) > 8 else "center")
                ax.xaxis.set_minor_locator(matplotlib.ticker.NullLocator())
            band = spec.get("band")
            if band and band[0] is not None:
                ax.axvspan(band[0], band[1], color="#e2a23a", alpha=0.12, lw=0)
                if spec.get("band_label"):
                    ax.text(band[0], 1.0, " " + spec["band_label"], transform=ax.get_xaxis_transform(), va="top", fontsize=ls_ * 0.95, color="#8a5a10")
            for a in [ax] + ([ax2] if ax2 else []):
                if s["logx"]:
                    a.set_xscale("log")
            if s["logy"]:
                ax.set_yscale("log")
            if s["xlim"]:
                ax.set_xlim(*[None if v is None else float(v) for v in s["xlim"]])
            if s["ylim"]:
                ax.set_ylim(*[None if v is None else float(v) for v in s["ylim"]])
            if ax2 is not None:
                ax2.set_ylabel(s["y2label"], fontsize=fs)
                ax2.tick_params(labelsize=ts, direction=s["tick_dir"])
                if s["y2lim"]:
                    ax2.set_ylim(*[None if v is None else float(v) for v in s["y2lim"]])
            if s["legend"] and handles and (len(handles) > 1 or spec.get("legend_single")):
                ax.legend(handles=handles, labels=[h.get_label() for h in handles], loc=s["legend_loc"], frameon=bool(s["legend_frame"]),
                          ncol=int(s["legend_cols"] or 1), fontsize=ls_)
        if s["invert_x"]:
            ax.invert_xaxis()
        if s["invert_y"]:
            ax.invert_yaxis()
        if kind != "corrmatrix":
            ax.set_xlabel(s["xlabel"], fontsize=fs)
            ax.set_ylabel(s["ylabel"], fontsize=fs)
            ax.tick_params(labelsize=ts, which="both", top=bool(s["ticks_all_sides"]),
                           right=bool(s["ticks_all_sides"]) and ax2 is None, direction=s["tick_dir"])
            if s["minor_ticks"] and kind not in ("heatmap",) and not s["logx"] and not spec.get("xticklabels"):
                ax.xaxis.set_minor_locator(AutoMinorLocator())
            if s["minor_ticks"] and kind not in ("heatmap",) and not s["logy"]:
                ax.yaxis.set_minor_locator(AutoMinorLocator())
            if s["grid_major"]:
                ax.grid(True, which="major", ls=s["grid_style"], alpha=s["grid_alpha"], lw=s["grid_width"])
            if s["grid_minor"]:
                ax.grid(True, which="minor", ls=":", alpha=s["grid_alpha"] * 0.7, lw=s["grid_width"] * 0.6)
            if not s["grid_major"] and not s["grid_minor"]:
                ax.grid(False)
            if s["frame"] == "open":
                ax.spines["top"].set_visible(False)
                ax.spines["right"].set_visible(ax2 is not None)
                ax.tick_params(which="both", top=False, right=False)
        if s["title"]:
            ax.set_title(s["title"], fontsize=float(s["title_size"] or fs * 1.1), fontweight="bold" if s["title_bold"] else "normal")
        if s["annotation"]:
            ax.text(0.97, 0.03, s["annotation"], transform=ax.transAxes, ha="right", va="bottom", fontsize=ls_)
    return fig, s


def render(spec, fmt="png", dpi=None):
    if fmt not in FORMATS:
        raise ValueError(f"format must be one of {', '.join(FORMATS)}")
    with _lock, matplotlib.rc_context({"pdf.fonttype": 42, "ps.fonttype": 42, "svg.fonttype": "none"}):
        fig, s = draw(spec)
        buf = io.BytesIO()
        kw = dict(format={"jpg": "jpeg"}.get(fmt, fmt), dpi=int(dpi or s["dpi"]), transparent=s["background"] == "transparent" and fmt not in ("jpg", "eps"))
        if fmt == "jpg":
            kw["pil_kwargs"] = {"quality": 95}
        if fmt == "tiff":
            kw["pil_kwargs"] = {"compression": "tiff_lzw"}
        fig.savefig(buf, **kw)
        return buf.getvalue()


def data_csv(spec):
    """The figure's data as CSV text (one block of columns per series; maps and matrices as grids)."""
    out = io.StringIO()
    w = csv.writer(out)
    k = spec.get("kind")
    if k == "heatmap":
        m = spec["map"]
        v = _arr(m["v"]).reshape(int(m["ny"]), int(m["nx"]))
        w.writerow(["y \\ x"] + [f"{m['x0'] + (i + 0.5) * m['dx']:.6g}" for i in range(int(m["nx"]))])
        for j in range(int(m["ny"])):
            w.writerow([f"{m['y0'] + (j + 0.5) * m['dy']:.6g}"] + ["" if not np.isfinite(c) else f"{c:.6g}" for c in v[j]])
    elif k == "corrmatrix":
        mx = spec["matrix"]
        w.writerow([""] + mx["labels"])
        for lab, r in zip(mx["labels"], mx["values"]):
            w.writerow([lab] + ["" if c is None else c for c in r])
    else:
        st = _style(spec)
        ser = spec.get("series") or []
        n = max((len(s_.get("x") or []) for s_ in ser), default=0)
        head = []
        for s_ in ser:
            nm = s_.get("name") or "series"
            head += [f"{nm} | {st['xlabel'] or 'x'}", f"{nm} | {st['ylabel'] or 'y'}"] + ([f"{nm} | ±"] if s_.get("yerr") else [])
        w.writerow(head)
        for i in range(n):
            row = []
            for s_ in ser:
                xs, ys = s_.get("x") or [], s_.get("y") or []
                row += [xs[i] if i < len(xs) else "", ys[i] if i < len(ys) else ""]
                if s_.get("yerr"):
                    row.append(s_["yerr"][i] if i < len(s_["yerr"]) else "")
            w.writerow(["" if v is None else v for v in row])
    return out.getvalue()


def _safe(name):
    return re.sub(r"[^\w.\-]+", "_", name or "figure").strip("_")[:120] or "figure"


@router.post("/render")
def render_route(body: dict = Body(...)):
    """{spec, format, dpi?} -> the figure file. A preview is the same call with format png and a low dpi."""
    fmt = str(body.get("format") or "png").lower()
    try:
        data = render(body.get("spec") or {}, fmt, body.get("dpi"))
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(422, f"figure: {e}")
    name = _safe((body.get("spec") or {}).get("name"))
    return Response(data, media_type=FORMATS[fmt], headers={"Content-Disposition": f'attachment; filename="{name}.{fmt}"'})


@router.post("/zip")
def zip_route(body: dict = Body(...)):
    """{figures: [spec], formats: [..], files: {path: text}} -> ZIP: figures/<name>.<fmt>, data/<name>.csv,
    specs/<name>.json, the extra files (results), README.txt."""
    figs, fmts = body.get("figures") or [], [str(f).lower() for f in body.get("formats") or ["png"]]
    bad = [f for f in fmts if f not in FORMATS]
    if bad or not figs:
        raise HTTPException(422, f"unknown format(s) {bad}" if bad else "no figures")
    buf, t0, used, errors = io.BytesIO(), time.time(), set(), []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for spec in figs:
            base = _safe(spec.get("name"))
            k = 2
            name = base
            while name in used:
                name, k = f"{base}_{k}", k + 1
            used.add(name)
            for f in fmts:
                try:
                    z.writestr(f"figures/{f}/{name}.{f}", render(spec, f))
                except Exception as e:                            # one bad figure must not lose the others
                    errors.append(f"{name}.{f}: {type(e).__name__}: {e}")
            z.writestr(f"data/{name}.csv", data_csv(spec))
            z.writestr(f"specs/{name}.json", json.dumps(spec, indent=1))
        for path, text in (body.get("files") or {}).items():
            z.writestr(re.sub(r"[^\w./\-]+", "_", path).lstrip("/."), text)
        z.writestr("README.txt", "NanoCut Graph Studio export\n\n"
                   f"{len(figs)} figures in {', '.join(fmts)}; generated {time.strftime('%Y-%m-%d %H:%M:%S')} in {time.time() - t0:.1f} s.\n"
                   "figures/<format>/  the figures (vector formats embed TrueType fonts as Type 42; SVG keeps text as text)\n"
                   "data/              the numbers drawn in each figure (CSV)\n"
                   "specs/             each figure's settings (JSON; load into Graph Studio to edit again)\n"
                   "results/           every analysed quantity (when included): all_scalars.csv, curves, analysis.json, definitions\n"
                   + (f"\nErrors:\n" + "\n".join(errors) if errors else ""))
    return Response(buf.getvalue(), media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="nanocut_graphs.zip"'})


@router.get("/formats")
def formats():
    return dict(formats=list(FORMATS), palettes=list(PALETTES), fonts=list(FONTS), style=STYLE)
