# LAMMPS Python module / library interface — condensed exact reference

Sources: LAMMPS manual 30Sep2026 (Programmer Guide ch.1 "LAMMPS Library Interfaces", ch.2 "Use Python with LAMMPS",
ch.4 "Information for Developers"), docs.lammps.org (Python_*.html, Library.html), python/lammps/{core,constants,
__init__,pylammps}.py at git tag `stable_22Jul2025` and branch `stable` (=30Sep2026), pypi.org/project/lammps.
Target runtime: PyPI wheel **2025.7.22.x** (`lammps.__version__ == 20250722`). Items only in the 30Sep2026 manual are
flagged **[post-wheel]**.

---

## 0. Install / wheel facts

- `pip install lammps` (unofficial PyPI package by njzjz, GPLv2). Versions `2025.7.22.{0.1,0.2,1.0,2.0,4.0}`;
  `2025.7.22.0.0` was yanked ("MPI is broken"). Wheels: win_amd64, manylinux (glibc>=2.27/2.28) x86-64+aarch64,
  macOS>=11 x86-64+arm64. Requires Python >=3.7. "Most packages are enabled."
- MPI: Linux/macOS wheels are built against **MPICH** (MPICH ABI, i.e. `libmpi.so.12` must be loadable);
  Windows wheel against **Microsoft MPI** (`msmpi.dll`, install MS-MPI runtime `msmpisetup.exe`, reboot).
  `pip install lammps[mpi]` pulls an MPI if you have none. mpi4py must use the *same* MPI implementation.
- The module checks `lammps.__version__` (parsed from package metadata `YYYY.MM.DD` -> `YYYYMMDD`) against
  `lammps_version()` of the loaded shared library; mismatch raises `AttributeError`
  ("LAMMPS Python module installed for LAMMPS version %d, but shared library is version %d"). Skipped when
  `__version__ == 0` (in-place source-tree use).
- Load failure symptom: `OSError: Could not load LAMMPS dynamic library`.
- Package layout: `lammps/__init__.py` does `from .constants import *; from .core import *; from .data import *;
  from .pylammps import *` (22Jul2025). In 30Sep2026 `.pylammps` import is gone (PyLammps removed).
  `lammps.formats` (LogFile, AvgChunkFile) must be imported explicitly: `from lammps.formats import LogFile`.
- NOTE: on this machine (C:\Python312) `import lammps` currently fails — the wheel is NOT installed in that interpreter.

## 1. Creating / deleting an instance

```python
from lammps import lammps
lmp = lammps(name='', cmdargs=None, ptr=None, comm=None)
```
- `name`: shared-library suffix ("mpi" -> liblammps_mpi.so; "" -> liblammps.so / liblammps.dll).
- `cmdargs`: list of str (or bytes) = LAMMPS command-line switches. The wrapper prepends `"lammps"` as argv[0]
  **only when cmdargs is not None** (otherwise argc=0, argv=NULL). Non-str/bytes entries raise `TypeError`.
- `ptr`: existing LAMMPS C++ instance pointer (embedded use via `python` command). `comm`: mpi4py communicator
  (-> `lammps_open`); None -> `lammps_open_no_mpi` (MPI_COMM_WORLD).
- Recommended quiet args for a validator: `lammps(cmdargs=["-log","none","-screen","none","-nocite"])`.
  Switch meanings (manual 4.2): `-log none` no log file; `-screen none` no screen output (`-sc`); `-nocite`/`-nc`
  disable citation reminder; `-echo none|screen|log|both`; `-var name value`; `-in file`; `-nonbuf` unbuffered output;
  `-sf suffix`, `-pk pkg args`, `-k on` (Kokkos). With `-screen none` nothing is printed, so thermo must be read via
  `get_thermo`/`last_thermo`, not by scraping stdout.
- `lmp.close()` — `lammps_close`; optional (destructor also closes). `lmp.finalize()` — also calls
  `lammps_mpi_finalize`, `lammps_kokkos_finalize`, `lammps_python_finalize`, `lammps_plugin_finalize`;
  **no LAMMPS instance may be created afterwards** (unless built without MPI and Kokkos). Never call `finalize()`
  in a long-lived validator process; just `close()`.
- Context manager exists in core.py: `__enter__` returns self, `__exit__` calls `close()`:
  `with lammps(cmdargs=[...]) as lmp: ...`
- Multiple instances in one process are allowed (`lmp1 = lammps(); lmp2 = lammps()`), sequential use only
  (not thread-safe in general; one MPI communicator per instance if threaded).
- `lmp.version()` -> int `YYYYMMDD`. `lammps.__version__` module constant, same format.
- `lmp.error(error_type, error_text)` raise a LAMMPS error from Python (LMP_ERROR_* constants).

## 2. Executing commands

| Method | C function | Notes |
|---|---|---|
| `lmp.file(path)` | `lammps_file` | processes file line by line (like `include`); returns at EOF |
| `lmp.command(cmd)` | `lammps_command` | ONE command; embedded newlines are part of the command, do not split |
| `lmp.commands_list(cmdlist)` | `lammps_commands_list` | list of str, joined with newlines -> commands_string |
| `lmp.commands_string(multicmd)` | `lammps_commands_string` | multi-line block; `&` continuation, `#` comments, `${v}`/`$(expr)` substitution, triple quotes, and `jump SELF label` loops (since 21Nov2023) all work |
| `lmp.expand(line)` | `lammps_expand` | variable-expand a line without executing |
| `lmp.eval(expr)` | `lammps_eval` (4Feb2025) | evaluate equal-style expression string -> float |
| `lmp.cmd.<name>(*args)` | — | `L.cmd.region("box block", 0, 10, 0, 5, -0.5, 0.5)` joins str(args) with spaces |

Parsing (manual 6.2, Input class): each line: (1) `&` at end -> continue; (2) `#` to EOL is comment (not inside
triple quotes); (3) `$x`, `${name}`, `$(expr)` / `$(expr:%fmt)` substituted (no nesting); (4) split on whitespace;
(5) first word = command name, rest = args; (6) quotes `'`, `"`, `"""` group an argument.
`Input::one(string)` makes a copy, parses, executes, returns command name (nullptr if empty). `Input::file()` reads
`infile` until EOF; `Input::file(const char*)` pushes the current file on a stack (how `include` works).
Commands are dispatched through a command factory: a class derived from `Command` is instantiated, its
`command(narg,arg)` runs, then it is deleted. "Style" commands (`atom_style`, `pair_style`, ...) replace a single
instance; non-style commands (`fix`, `compute`, `region`, `dump`, `group`) create many instances stored in lists
(Modify for fixes/computes, Domain for regions, Output for dumps).

## 3. Errors / exceptions

- LAMMPS is always built with C++ exceptions (since 21Nov2023 `lammps_config_has_exceptions()` always 1).
  Library functions catch the C++ exception and set an error status; `lammps_has_error(handle)` -> 0/1;
  `lammps_get_last_error_message(handle, buf, n)` returns **1 = error on all ranks (often recoverable)**,
  **2 = single-rank abort (not recoverable, other ranks may hang)**. Passing NULL buffer clears the status.
- Python: every wrapped call runs inside `with ExceptionCheck(self):`; on exit it checks
  `lammps_has_error` and raises `self._lammps_exception`, which is
  `MPIAbortException(msg)` if error_type == 2 else plain `Exception(msg)`. The message text is included.
  ```python
  from lammps import lammps, MPIAbortException
  try: lmp.command('unknown')
  except MPIAbortException as e: ...   # single rank died -> terminate process
  except Exception as e: ...           # all ranks saw the error
  ```
- **There is NO `lmp.has_error()` / `lmp.get_last_error_message()` Python method** (neither in 22Jul2025 nor
  30Sep2026 core.py; only ctypes bindings `lmp.lib.lammps_has_error(lmp.lmp)` etc. exist). Use try/except.
- `lmp.set_show_error(flag)` (2Apr2025) -> previous flag; 0 stops LAMMPS printing the error itself before
  throwing (avoids double printing). `lmp.has_exceptions` property (always True).
- Warning (manual 2.10): after a caught exception "the current LAMMPS process is in an illegal state and must be
  terminated" may apply; for a validator, safest is: discard the instance (`close()`), or run each validation in a
  fresh subprocess. Errors raised before `create_box` vs after can leave partially-built state; always re-create.
- Standalone executable behavior (Programmer Guide "Errors versus exceptions"): the `lmp` binary catches the
  exception, prints the message and calls MPI_Abort / exits; only the library interface converts to a status.

## 4. System / global properties

- `lmp.get_natoms()` -> int (via double, exact to 2^53).
- `lmp.extract_box()` -> `[boxlo[3], boxhi[3], xy, yz, xz, periodicity[3] (0/1), box_change (int)]`.
- `lmp.reset_box(boxlo, boxhi, xy, yz, xz)` — only before atoms exist.
- `lmp.get_thermo(name)` -> float or None. Evaluates the thermo keyword *now* (`pe`, `ke`, `temp`, `press`,
  `vol`, `step`, `atoms`, `lx`,`ly`,`lz`, `xlo`.., `etotal`, `enthalpy`, `density`, `cpu`, ... any `thermo_style`
  keyword). Requires a prior `run` (or `run 0`) for energy-type quantities to be current (they need setup).
- `lmp.last_thermo()` -> dict `{keyword: value}` of the **last printed** thermo line, or None if none yet
  (cached; does not trigger evaluation). `lmp.last_thermo_step` property -> int, negative if none.
- `lmp.extract_setting(name)` -> int, -1 if unknown. Keys: `bigint`,`tagint`,`imageint` (byte sizes),
  `dimension`, `box_exist`, `triclinic`, `newton_bond`, `newton_pair`, `nthreads`, `nlocal`, `nghost`, `nall`,
  `nmax`, `ntypes`, `nbondtypes`, `nangletypes`, `ndihedraltypes`, `nimpropertypes`, `molecule_flag`, `q_flag`,
  `mu_flag`, `rmass_flag`, `radius_flag`, `omega_flag`, `torque_flag`, `angmom_flag`, `ellipsoid_flag`,
  `line_flag`, `tri_flag`, `body_flag`, `thermo_every`, `thermo_norm`, `neigh_every`, `neigh_delay`,
  `neigh_dist_check`, `neigh_ago`, `nbondlist`, `nanglelist`, `ndihedrallist`, `nimproperlist`, `world_rank`,
  `world_size`, `universe_rank`, `universe_size`, `comm_style`, `comm_layout`, `comm_mode`, `ghost_velocity`,
  `kokkos_active`, `kokkos_nthreads`, `kokkos_ngpus`, `MAX_GROUP`, `IMGMASK`, `IMGMAX`, `IMGBITS`, `IMG2BITS`.
- `lmp.extract_global(name, dtype=None)` -> scalar, list, str, or None. `dtype=None` (= `LAMMPS_AUTODETECT`,
  which *is* `None` in constants.py) auto-detects via `extract_global_datatype(name)`. Returns a Python list for
  multi-element entries, `str` for `LAMMPS_STRING`. Supported names (type, len):
  - timestep: `dt` (double), `ntimestep` (bigint), `atime` (double), `atimestep` (bigint), `respa_levels`, `respa_dt`
  - box: `boxlo`,`boxhi` (double 3), `boxxlo`..`boxzhi` (double 1), `sublo`,`subhi`,`sublo_lambda`,`subhi_lambda`
    (double 3), `periodicity` (int 3), `triclinic` (int), `xy`,`yz`,`xz`, `xlattice`,`ylattice`,`zlattice`,
    `procgrid` (int 3)
  - sizes: `natoms`,`nbonds`,`nangles`,`ndihedrals`,`nimpropers` (bigint), `nlocal`,`nghost`,`nmax`,`ntypes` (int),
    `special_lj`,`special_coul` (double 4), `map_style`, `map_tag_max`, `sametag`, `sortfreq`, `nextsort`
  - style strings: `atom_style`,`pair_style`,`bond_style`,`angle_style`,`dihedral_style`,`improper_style`,
    `kspace_style`, `units` (str)
  - neighbor: `neigh_skin`,`neigh_cutmin`,`neigh_cutmax` (double), `neigh_bondlist` (2d int nbondlist x 3:
    atom1,atom2,type), `neigh_anglelist` (x4), `neigh_dihedrallist`, `neigh_improperlist` (x5)
  - tally: `eflag_global`,`eflag_atom`,`vflag_global`,`vflag_atom` (bigint)
  - version: `git_commit`,`git_branch`,`git_descriptor`,`lammps_version` (str)
  - unit constants: `boltz`,`hplanck`,`mvv2e`,`ftm2v`,`mv2d`,`nktv2p`,`qqr2e`,`qe2f`,`vxmu2f`,`xxt2kmu`,
    `dielectric`,`qqrd2e`,`e_mass`,`hhmrr2e`,`mvh2r`,`angstrom`,`femtosecond`,`qelectron` (double)
  Pointers are persistent until `clear`. Writing through them is discouraged (use input commands).
- `lmp.extract_global_datatype(name)` -> LAMMPS_* int or None.
- `lmp.extract_pair(name)` / `extract_pair_dimension(name)` (29Aug2024): pair-style `Pair::extract()` data,
  e.g. `epsilon`, `sigma` for lj/cut -> list of lists.
- `lmp.map_atom(atomid)` -> local index or -1.
- `lmp.get_mpi_comm()`, `lmp.get_os_info()`, `lmp.flush_buffers()`.

## 5. Per-atom data

- `lmp.extract_atom(name, dtype=None)` -> ctypes pointer (`POINTER(c_double)`, `POINTER(POINTER(c_double))`,
  int32/int64 variants) or None. Data is **per-MPI-rank local**, indexed `[0:nlocal]` (storage `[0:nmax]`,
  ghost range validity depends on property/`comm_modify vel yes`). Order/size change at every reneighbor; pointers
  are not persistent — re-extract after every command. Writable in place.
- `lmp.numpy.extract_atom(name, dtype=None, nelem=None, dim=None)` -> numpy view, rows = value of
  `extract_atom_size(name, LMP_SIZE_ROWS)` (storage is [0:nmax]; only [0:nlocal] is guaranteed valid, ghost rows
  [nlocal:nlocal+nghost] only for properties communicated to ghosts). Always slice `[:nlocal]` (`nlocal =
  lmp.extract_setting("nlocal")`). `nelem`/`dim` override the shape unchecked. Writes go straight into LAMMPS memory.
- `lmp.extract_atom_datatype(name)`, `lmp.extract_atom_size(name, dtype)` (dtype = `LMP_SIZE_ROWS` /
  `LMP_SIZE_COLS` for arrays).
- Keyword table (Atom::extract): `mass` (double, **per-type**, length ntypes+1, index 0 unused), `id` (tagint 1),
  `type` (int 1), `mask` (int 1, group bitmask), `image` (imageint 1, encoded), `x`,`v`,`f` (double 3),
  `molecule` (int 1), `q` (double 1), `mu` (double 3), `omega`,`angmom`,`torque` (double 3), `radius`,`rmass`
  (double 1; rmass is NULL when per-type masses), `ellipsoid`,`line`,`tri`,`body` (int 1), `quat` (double 4),
  `temperature`,`heatflow` (double 1), `i_name`,`d_name` (fix property/atom vectors), `i2_name`,`d2_name` (arrays).
- `lmp.encode_image_flags(ix,iy,iz)`, `lmp.decode_image_flags(image)` -> [ix,iy,iz].
- `lmp.create_atoms(n, atomid, atype, x, v=None, image=None, shrinkexceed=False)` -> count created.
- `lmp.create_molecule(molid, jsonstr)` (22Jul2025).
- Robust pattern for a validator (single rank): `n = lmp.get_natoms(); ids = lmp.numpy.extract_atom("id")[:n]`
  or use gather (ordered by ID) below.

## 6. Gather / scatter (global, ordered by atom ID, copies)

```python
data = lmp.gather_atoms(name, dtype, count)              # ctypes array len natoms*count, ordered by ID (IDs must be 1..N consecutive)
data = lmp.gather_atoms_concat(name, dtype, count)       # unordered concat of per-rank chunks (no consecutive-ID requirement)
data = lmp.gather_atoms_subset(name, dtype, count, ndata, ids)
lmp.scatter_atoms(name, dtype, count, data)              # data = ctypes (c_double*n)(...) or (c_int*n)(...)
lmp.scatter_atoms_subset(name, dtype, count, ndata, ids, data)
# same signatures, but name may also be "c_ID" (per-atom compute), "f_ID" (per-atom fix), "d_name"/"i_name"/"d2_name"/"i2_name":
lmp.gather(name, dtype, count); lmp.gather_concat(...); lmp.gather_subset(...); lmp.scatter(...); lmp.scatter_subset(...)
(nb, bonds) = lmp.gather_bonds()        # flat ctypes [type,a1,a2]*nb ; numpy: lmp.numpy.gather_bonds() -> (nb,3)
lmp.gather_angles() (nangles,4), gather_dihedrals() (n,5), gather_impropers() (n,5)
```
- `dtype`: 0 = int, 1 = double. `count`: 1 (`type`,`q`,`id`), 3 (`x`,`v`,`f`; also `image` to unpack flags).
- Restrictions: not with `-DLAMMPS_BIGBIG`; natoms <= 2^31-1; subset variants need an atom map.
- `numpy.frombuffer(data)` / `np.ctypeslib.as_array(data).reshape(-1,count)` to view the result.

## 7. Computes, fixes, variables

Constants (`lammps.constants`, all ints):
`LAMMPS_AUTODETECT=None, LAMMPS_NONE=-1, LAMMPS_INT=0, LAMMPS_INT_2D=1, LAMMPS_DOUBLE=2, LAMMPS_DOUBLE_2D=3,
LAMMPS_INT64=4, LAMMPS_INT64_2D=5, LAMMPS_STRING=6; LMP_STYLE_GLOBAL=0, LMP_STYLE_ATOM=1, LMP_STYLE_LOCAL=2;
LMP_TYPE_SCALAR=0, LMP_TYPE_VECTOR=1, LMP_TYPE_ARRAY=2, LMP_SIZE_VECTOR=3, LMP_SIZE_ROWS=4, LMP_SIZE_COLS=5;
LMP_VAR_EQUAL=0, LMP_VAR_ATOM=1, LMP_VAR_VECTOR=2, LMP_VAR_STRING=3; LMP_ERROR_WARNING=0, LMP_ERROR_ONE=1,
LMP_ERROR_ALL=2, LMP_ERROR_WORLD=4, LMP_ERROR_UNIVERSE=8; LMP_BUFSIZE, LMP_MAX_GROUP (=32)`.

- `lmp.extract_compute(cid, cstyle, ctype)` -> float (scalar / size requests) or ctypes pointer, None if bad id
  or combination. Table (style, type -> data):
  GLOBAL+SCALAR global scalar; GLOBAL+VECTOR double* vector; GLOBAL+ARRAY double**; GLOBAL+SIZE_VECTOR /
  SIZE_ROWS / SIZE_COLS -> int; ATOM+VECTOR per-atom double[nlocal]; ATOM+ARRAY per-atom double[nlocal][ncols];
  ATOM+SIZE_COLS (0 if vector); LOCAL+VECTOR / ARRAY / SIZE_ROWS / SIZE_COLS.
  **If the compute is not current it is invoked** — may error if invoked at an invalid time (e.g. before any
  run/`run 0`, or a compute needing a neighbor list before setup). Pointers are not persistent.
  Built-in: `thermo_temp`, `thermo_press`, `thermo_pe` (e.g. `lmp.extract_compute("thermo_pe", LMP_STYLE_GLOBAL,
  LMP_TYPE_SCALAR)`).
- `lmp.numpy.extract_compute(cid, cstyle, ctype)` -> float / numpy array (shapes from the SIZE queries).
- `lmp.extract_fix(fid, fstyle, ftype, nrow=0, ncol=0)` -> for GLOBAL always a **single float** (element
  `[nrow]` of vector or `[nrow][ncol]` of array, zero-based; copy); SIZE_* -> int; ATOM/LOCAL -> pointer.
  `lmp.numpy.extract_fix(...)` same but arrays as numpy. Fix data (e.g. `fix ave/time`) only valid when the fix's
  `nevery` condition has been met; errors otherwise.
- `lmp.extract_variable(name, group=None, vartype=None)`: evaluates and returns a **copy**:
  equal-style (and compatible: internal, python-numeric) -> float; atom-style -> list/ctypes of nlocal doubles
  (zero for atoms outside `group`, default "all"); vector-style -> list; other styles (string, index, loop, ...)
  -> str. `vartype` auto-detected via `lammps_extract_variable_datatype` when None; or `LMP_VAR_EQUAL/ATOM/
  VECTOR/STRING`. Returns None if variable unknown. `lmp.numpy.extract_variable(name, group=None, vartype=0)`
  (default 0 = EQUAL! pass vartype explicitly or use the non-numpy variant for autodetect).
- Setting: `lmp.set_string_variable(name, value)` (7Feb2024; value str()-converted; returns 0 / -1),
  `lmp.set_internal_variable(name, value)` (float; for `variable name internal`), `lmp.set_variable(name, value)`
  deprecated alias of set_string_variable. Only string-style and internal-style variables can be set this way;
  anything else: `lmp.command(f"variable {name} equal {val}")` (redefining equal-style is allowed; index/loop are not).
- `lmp.clearstep_compute()`, `lmp.addstep_compute(step)`, `lmp.addstep_compute_all(step)` — schedule compute
  invocation for a future step when calling computes between runs.

## 8. Configuration / introspection

Properties: `lmp.has_mpi_support`, `lmp.has_exceptions`, `lmp.has_gzip_support`, `lmp.has_png_support`,
`lmp.has_jpeg_support`, `lmp.has_ffmpeg_support`, `lmp.has_curl_support`, `lmp.has_gpu_device`,
`lmp.accelerator_config` (nested dict), `lmp.installed_packages` (list[str]), `lmp.is_running` (bool; True inside
a run/minimize — e.g. from a fix python/invoke callback). **[post-wheel]** `lmp.has_omp_support` (C fn
10Sep2025) — absent in 22Jul2025; use `"OPENMP" in lmp.installed_packages` or `accelerator_config`.
Methods: `lmp.has_package(name)`, `lmp.has_style(category, name)`, `lmp.available_styles(category)` -> list;
categories: `atom`, `integrate`, `minimize`, `pair`, `bond`, `angle`, `dihedral`, `improper`, `kspace`,
`compute`, `fix`, `region`, `dump`, `command`. `lmp.has_id(category, name)`, `lmp.available_ids(category)` for
categories `compute`, `dump`, `fix`, `group`, `molecule`, `region`, `variable` (since 22Jul2025 `group` returns a
32-slot list with None holes; bit `1<<idx` matches per-atom `mask`). `lmp.available_plugins(category=None)`.
`lmp.get_gpu_device_info()`. `lmp.force_timeout()` — soft-stop a running run at the next loop iteration
(only meaningful from another thread / signal handler / callback).

## 9. Neighbor lists (brief)

`idx = lmp.find_pair_neighlist(style, exact=True, nsub=0, reqid=0)` / `find_fix_neighlist(fixid, reqid=0)` /
`find_compute_neighlist(computeid, reqid=0)` -> index or -1 (lists exist only after setup, i.e. after `run 0`).
`nl = lmp.numpy.get_neighlist(idx)`; `nl.size`; `i, neigh = nl.get(k)` (numpy array of local indices);
`nl.find(iatom)`. ctypes variant `lmp.get_neighlist(idx)` -> `NeighList` (tuples `(i, n, POINTER(c_int))`).

## 10. PyLammps / IPyLammps (deprecated; present in 22Jul2025 wheel, REMOVED in 30Sep2026)

`from lammps import PyLammps, IPyLammps` works with the wheel; prints banner "The PyLammps class is obsolete and
will be removed from LAMMPS soon. Please use the lammps Python class instead." (no DeprecationWarning object).
`PyLammps(name="", cmdargs=None, ptr=None, comm=None, verbose=False)`; `IPyLammps(name="",cmdargs=None,ptr=None,
comm=None)` adds `image(filename="snapshot.png", group="all", color="type", diameter="type", size=None, view=None,
center=None, up=None, zoom=1.0, background_color="white")` (write_dump image) and `video(filename)`.
- `L.lmp` underlying `lammps`; `L.file(f)`, `L.command(cmd)`, `L.<anycommand>(*args, verbose=False)` joins
  `str(arg)`s with spaces and captures stdout via fd-level `OutputCapture` (os.dup2 of fd 1) — returns None / str /
  list of lines. Does NOT work with `-screen none` capture semantics (nothing to capture).
- `L.system` namedtuple parsed from `info system` (natoms, ntypes, nbonds, xlo..zhi, units, atom_style, pair_style,
  dimensions, ...). `L.atoms[i]` (local index; `.id .type .mol .charge .mass .position .velocity .force .radius`;
  setters for position/velocity/force; known bugs: `omega` reads `torque`). `L.computes`, `L.fixes`, `L.dumps`
  (lists of dicts from `info`), `L.groups` (= `available_ids("group")`), `L.variables` (dict name->Variable with
  `.style`, `.value`; setter only for equal/string). `L.eval(expr)` -> float or str (rank 0 only; uses `print
  "$(expr)"`). `L.runs` list of `Run(thermo=...)`; `L.last_run.thermo.Step`, `.Temp`, ... are per-step lists —
  per-step capture needs the PYTHON package (adds a `fix python/invoke ... end_of_step`); otherwise only final step.
- `L.enable_cmd_history = True`, `L.write_script(path)`, `L.clear_cmd_history()`, context manager supported.
- Recommendation: do not build the tool on PyLammps; use `lammps` + `lmp.cmd` instead.

## 11. Output readers

`lammps.formats.LogFile(filename)`: `.runs` list of dicts `{thermo_keyword: [values...]}` (line/multi/yaml
thermo styles), `.errors` list. `lammps.formats.AvgChunkFile(filename)`: `.timesteps`, `.total_count`, `.chunks`.

## 12. API delta: 22Jul2025 wheel vs 30Sep2026 manual

Present in wheel (dated <= 22Jul2025): `eval` (4Feb2025), `set_show_error` (2Apr2025), `create_molecule`,
`available_ids` group semantics (22Jul2025), `extract_atom_size` (19Nov2024), `extract_pair*` (29Aug2024),
`map_atom` (27Jun2024), `set_string_variable`/`set_internal_variable` (7Feb2024), `last_thermo` (15Jun2023),
`has_curl_support`, `lammps_plugin_finalize` (12Jun2025), context manager, `cmd` wrapper, PyLammps.
**[post-wheel]** (NOT in 22Jul2025): `has_omp_support` property (10Sep2025); KOKKOS device->host sync inside
`extract_atom` (4Jul2026); removal of PyLammps/IPyLammps from the package (30Sep2026 docs/branch); brotli/7-zip
compressed-file support (11Feb2026); `$(expr:%fmt)` second-conversion rejection (2Sep2026); VTK package removed
(2Sep2026); minimum C++17 (10Sep2025). No other `lammps.lammps` method is dated after 22Jul2025 in the manual.

## 13. Programmer-guide essentials (for reasoning about validation)

- Lifecycle: `LAMMPS *lmp = new LAMMPS(argc, argv, comm); lmp->input->file(); delete lmp;` — the library
  functions do exactly this around `Input::file/one`. The LAMMPS object composes `Atom`, `Comm`, `Domain` (box,
  regions, lattice), `Force` (pair/bond/angle/dihedral/improper/kspace — single instance each), `Modify` (lists of
  `Fix` and `Compute` instances), `Group`, `Neighbor` (NeighRequest/NeighList), `Output` (Thermo, Dump list,
  WriteRestart), `Update` (Integrate: Verlet/Respa, Min), `Timer`, `Input`/`Variable`, `Error`.
- `run N [upto] [start N1] [stop N2] [pre yes|no] [post yes|no] [every M cmd...]`: `run 0` is legal — "only the
  thermodynamics of the system are computed and printed without taking a timestep" (does full setup: neighbor
  lists, forces, fix constraints) — the cheapest way to validate a deck end-to-end. `pre no` skips setup (forced
  on for the first run; erroneous if the system changed between runs); `post no` prints one-line timing only.
- Run flow: `Run::command` -> `update->integrate->init()`, `setup(flag)` (or `setup_minimal`) -> `run(N)` ->
  cleanup/`post_run`. Verlet::run per step: `ev_set()`; fix `initial_integrate`; `post_integrate`;
  `neighbor->decide()` -> if rebuild: `pre_exchange`, `domain->pbc()`, `reset_box()`, `comm->setup()`,
  `neighbor->setup_bins()`, `comm->exchange()`, `comm->borders()`, `pre_neighbor`, `neighbor->build()`,
  `post_neighbor` else `comm->forward_comm()`; `force_clear()`; `pre_force`; pair/bond/angle/dihedral/improper/
  kspace `compute()`; `pre_reverse`; `comm->reverse_comm()` (newton on); `post_force`; `final_integrate`;
  `end_of_step`; `output->write()` if due. Minimization uses `min_pre_exchange/min_pre_force/min_post_force`.
  Atoms are wrapped into the box only on reneighbor steps (dumped coords may be slightly outside the box).
- Modify: holds all fixes/computes; keeps per-stage lists of which fixes to invoke; thermo/variables query
  computes through it; `fix ... energy yes` contributions are summed via Modify.
- Errors: `Error::all()` (all ranks, error_type 1) vs `Error::one()` (single rank, type 2 -> MPIAbortException);
  warnings via `Error::warning()` go to screen/log only, never raise. Common validator-relevant messages:
  "Unknown command", "... command before simulation box is defined", "Unrecognized pair style", "All pair
  coeffs are not set", "Incorrect args for ...", "Did not assign all atoms correctly".

## 14. Minimal validator recipe (single rank)

```python
import numpy as np
from lammps import lammps, MPIAbortException, LMP_STYLE_GLOBAL, LMP_STYLE_ATOM, LMP_TYPE_SCALAR, LMP_TYPE_VECTOR, LMP_TYPE_ARRAY

def validate(deck_text, run0_only=True):
    with lammps(cmdargs=["-log","none","-screen","none","-nocite"]) as lmp:
        lmp.set_show_error(0)                      # we report the message ourselves
        try:
            lmp.commands_string(deck_text)         # deck may itself contain run; else:
            if run0_only and lmp.extract_setting("box_exist") == 1:
                lmp.command("run 0 post no")
        except MPIAbortException as e:
            return {"ok": False, "fatal": True, "error": str(e)}
        except Exception as e:
            return {"ok": False, "fatal": False, "error": str(e)}
        n = lmp.get_natoms()
        boxlo, boxhi, xy, yz, xz, periodic, box_change = lmp.extract_box()
        ids   = lmp.numpy.extract_atom("id")[:n].copy()      # local==global on 1 rank
        types = lmp.numpy.extract_atom("type")[:n].copy()
        x     = lmp.numpy.extract_atom("x")[:n].copy()        # copy! pointer dies on next command
        pe    = lmp.get_thermo("pe"); temp = lmp.get_thermo("temp")
        thermo = lmp.last_thermo()                            # dict of last thermo line or None
        return {"ok": True, "natoms": n, "box": (boxlo, boxhi), "units": lmp.extract_global("units"),
                "atom_style": lmp.extract_global("atom_style"), "pair_style": lmp.extract_global("pair_style"),
                "pe": pe, "temp": temp, "thermo": thermo, "ids": ids, "types": types, "x": x}
```
Caveats: `-screen none` suppresses `print`/`info` output too; use `get_thermo`/`extract_*` for data. Run each
untrusted deck in a subprocess (a type-2 error or a segfault inside a pair style takes the interpreter down).
Pre-check styles with `lmp.has_style("pair", name)` to give clearer messages than LAMMPS's "Unrecognized pair style".
Decks that `read_data` / `read_restart` / `include` need cwd set accordingly (paths are relative to the process cwd).
