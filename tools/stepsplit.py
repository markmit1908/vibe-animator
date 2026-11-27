"""
`convert --split`: convert STEP files too big for OCCT to load whole.

1. Index   one streaming pass over the text (stepindex.py): offsets and types, structure records kept.
2. Bodies  each solid / surface body's records (forward closure), vertices, faces, bytes.
3. Copies  duplicate bodies (Shapr3D bakes every copy in place): grouped by name (an "-N" / "_N" instance
           suffix ignored), face and point count, then confirmed by solving the rigid transform between the
           bodies' point sets (all their geometry points, within --match-tol). A confirmed copy isn't converted again: it instances the first one's mesh.
4. Convert the remaining bodies in units of at most --budget MB of STEP text. Each unit is written as a small
           standalone STEP (each body its own part, named @@<id>@@) and converted by `step2gltf.py convert` in a
           child process; --jobs run at once.
5. Merge   one .glb: the assembly tree (names, placements) is rebuilt from the index, bodies hang off their
           parts (one body: the part's own mesh; several: a child per body, named as `convert` names them).
"""
import json, math, os, re, struct, subprocess, sys, tempfile, time
import numpy as np
from stepindex import StepIndex, args_of, ref, refs_in, string, REF

BODY = {b"MANIFOLD_SOLID_BREP", b"BREP_WITH_VOIDS", b"SHELL_BASED_SURFACE_MODEL", b"FACETED_BREP"}
REPS = {b"SHAPE_REPRESENTATION", b"ADVANCED_BREP_SHAPE_REPRESENTATION", b"MANIFOLD_SURFACE_SHAPE_REPRESENTATION",
        b"FACETED_BREP_SHAPE_REPRESENTATION", b"GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION"}
STYLE = {b"PRESENTATION_STYLE_ASSIGNMENT", b"SURFACE_STYLE_USAGE", b"SURFACE_SIDE_STYLE", b"SURFACE_STYLE_FILL_AREA",
         b"FILL_AREA_STYLE", b"FILL_AREA_STYLE_COLOUR", b"COLOUR_RGB", b"DRAUGHTING_PRE_DEFINED_COLOUR",
         b"CURVE_STYLE", b"DRAUGHTING_PRE_DEFINED_CURVE_FONT", b"SURFACE_STYLE_TRANSPARENT",
         b"SURFACE_STYLE_RENDERING_WITH_PROPERTIES", b"SURFACE_STYLE_RENDERING", b"STYLED_ITEM",
         b"OVER_RIDING_STYLED_ITEM", b"PRESENTATION_STYLE_BY_CONTEXT", b"POSITIVE_LENGTH_MEASURE",
         b"SURFACE_STYLE_BOUNDARY", b"SURFACE_STYLE_SILHOUETTE", b"SURFACE_STYLE_PARAMETER_LINE",
         b"INVISIBILITY", b"COLOUR_SPECIFICATION"}
TAG = re.compile(r"^@@(\d+)@@$")


# ---------------------------------------------------------------- progress / logging
class Progress:
    """A one-line progress bar on stderr (a log line every 15 s when stderr isn't a terminal).
    log() always prints; debug() only with --verbose."""

    def __init__(self, verbose):
        self.tty = sys.stderr.isatty()
        self.verbose = verbose
        self.phase = None
        self.shown = False
        self.t0 = time.time()

    def _clear(self):
        if self.tty and self.shown:
            sys.stderr.write("\r\033[K"); self.shown = False

    def log(self, msg):
        self._clear()
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)
        self._draw(True)

    def debug(self, msg):
        if self.verbose:
            self.log(msg)

    def start(self, phase, total, fmt=None):
        self._clear()
        self.phase, self.total, self.done, self.extra = phase, max(total, 1), 0, ""
        self.fmt = fmt or (lambda v: f"{v:,}")
        self.ps = time.time(); self.last = 0
        self._draw(True)

    def update(self, done, extra=None):
        self.done = done
        if extra is not None:
            self.extra = extra
        self._draw()

    def end(self, msg=None):
        self.done = self.total
        self._draw(True)
        if self.tty and self.shown:
            sys.stderr.write("\n"); self.shown = False
        self.phase = None
        if msg:
            self.log(msg)

    def _draw(self, force=False):
        if self.phase is None:
            return
        t = time.time()
        if not force and t - self.last < (0.1 if self.tty else 15):
            return
        self.last = t
        f = min(self.done / self.total, 1.0)
        el = t - self.ps
        eta = f" ETA {dur(el / f - el)}" if 0.02 < f < 1 and el > 3 else ""
        if self.tty:
            w = 28; k = int(f * w)
            line = (f"{self.phase:<8} [{'█' * k}{'░' * (w - k)}] {f:6.1%}  "
                    f"{self.fmt(self.done)}/{self.fmt(self.total)}  {self.extra}{eta}  ({dur(t - self.t0)})")
            sys.stderr.write("\r\033[K" + line[:shutil_cols() - 1]); sys.stderr.flush(); self.shown = True
        elif not force or f >= 1:
            print(f"[{time.strftime('%H:%M:%S')}] {self.phase} {f:.0%} {self.fmt(self.done)}/{self.fmt(self.total)} "
                  f"{self.extra}{eta}", file=sys.stderr, flush=True)


def shutil_cols():
    try:
        return os.get_terminal_size(sys.stderr.fileno()).columns
    except OSError:
        return 200


def dur(s):
    s = int(s)
    return f"{s // 3600}h{s // 60 % 60:02d}m" if s >= 3600 else f"{s // 60}m{s % 60:02d}s" if s >= 60 else f"{s}s"


def mb(v):
    return f"{v / 1e6:,.0f} MB" if v < 1e9 else f"{v / 1e9:.2f} GB"


# ---------------------------------------------------------------- geometry helpers
def placement(ix, pid):
    """AXIS2_PLACEMENT_3D -> 4x4 (mm)."""
    a = args_of(ix.body(pid))
    def vec(r, default):
        if r is None:
            return np.array(default, float)
        b = ix.body(r)
        return np.array([float(x) for x in b[b.rfind(b"(") + 1:b.find(b")", b.rfind(b"("))].split(b",")], float)
    loc = vec(ref(a[1]), (0, 0, 0))
    z = vec(ref(a[2]) if len(a) > 2 else None, (0, 0, 1)); z /= np.linalg.norm(z)
    x = vec(ref(a[3]) if len(a) > 3 else None, (1, 0, 0))
    x = x - (x @ z) * z
    if np.linalg.norm(x) < 1e-12:
        x = np.array([1.0, 0, 0]) if abs(z[0]) < 0.9 else np.array([0, 1.0, 0]); x = x - (x @ z) * z
    x /= np.linalg.norm(x)
    M = np.eye(4); M[:3, 0] = x; M[:3, 1] = np.cross(z, x); M[:3, 2] = z; M[:3, 3] = loc
    return M


def to_mat(n):
    if "matrix" in n:
        return np.array(n["matrix"], float).reshape(4, 4).T
    M = np.eye(4)
    if "rotation" in n:
        x, y, z, w = n["rotation"]
        M[:3, :3] = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    if "scale" in n:
        M[:3, :3] = M[:3, :3] * np.array(n["scale"])
    if "translation" in n:
        M[:3, 3] = n["translation"]
    return M


def frame(pts):
    c = pts.mean(0)
    w, V = np.linalg.eigh(np.cov((pts - c).T) if len(pts) > 1 else np.eye(3))
    return dict(c=c, mom=w, axes=V, pts=pts)


def candidates(f0, f1, tol):
    """Rotations R with f1 ~= R f0 (from the principal axes; extra candidates for axisymmetric parts)."""
    import itertools
    A0, A1, m = f0["axes"], f1["axes"], f0["mom"]
    rel = lambda a, b: abs(a - b) <= 1e-4 * max(abs(a), abs(b), 1e-9)
    out = []
    for s in itertools.product((1, -1), repeat=3):
        R = A1 @ np.diag(s) @ A0.T
        if np.linalg.det(R) > 0:
            out.append(R)
    deg = [i for i in range(2) if rel(m[i], m[i + 1])]
    if deg:
        u_i = 2 if deg[0] == 0 else 0
        p0 = f0["pts"] - f0["c"]; p1 = f1["pts"] - f1["c"]
        for su in (1, -1):
            u0 = A0[:, u_i]; u1 = A1[:, u_i] * su
            r0 = p0 - np.outer(p0 @ u0, u0); k = np.argmax(np.linalg.norm(r0, axis=1))
            h0, d0 = p0[k] @ u0, np.linalg.norm(r0[k])
            if d0 < tol:
                continue
            r1 = p1 - np.outer(p1 @ u1, u1)
            hit = np.where((np.abs(p1 @ u1 - h0) < tol * 4) & (np.abs(np.linalg.norm(r1, axis=1) - d0) < tol * 4))[0]
            for j in hit[:24]:
                a0 = r0[k] / d0; b0 = np.cross(u0, a0)
                a1 = r1[j] / np.linalg.norm(r1[j]); b1 = np.cross(u1, a1)
                out.append(np.column_stack([a1, b1, u1]) @ np.column_stack([a0, b0, u0]).T)
    return out


def solve(f0, f1, tol):
    from scipy.spatial import cKDTree
    tree = cKDTree(f1["pts"])
    for R in candidates(f0, f1, tol):
        t = f1["c"] - R @ f0["c"]
        with np.errstate(all="ignore"):
            d, _ = tree.query(f0["pts"] @ R.T + t)
        if d.max() <= tol:
            return R, t
    return None


# ---------------------------------------------------------------- body closures (forked workers)
_IX = None
_SEEN = None


def _closure_job(bids):
    global _SEEN
    ix = _IX
    if _SEEN is None:
        _SEEN = bytearray(ix.max_id + 1)
    seen, mm, row, offs, lens, tc, mx = _SEEN, ix.mm, ix.row, ix.offs, ix.lens, ix.tcodes, ix.max_id
    cp = ix.types.get(b"CARTESIAN_POINT", -1)
    fcodes = {ix.types[t] for t in (b"ADVANCED_FACE", b"FACE_SURFACE") if t in ix.types}
    findall = REF.findall
    out = []
    for bid in bids:
        stack, ids, cps, faces, nbytes = [bid], [], [], 0, 0
        while stack:
            r = stack.pop()
            if r > mx or seen[r]:
                continue
            seen[r] = 1
            i = row[r]
            if i < 0:
                continue  # dangling reference
            ids.append(r)
            o = int(offs[i]); l = int(lens[i]); rec = mm[o:o + l]; nbytes += l
            c = tc[i]
            if c == cp:
                cps.append(rec)
            elif c in fcodes:
                faces += 1
            stack.extend(map(int, findall(rec, rec.find(b"=") + 1)))
        for r in ids:
            seen[r] = 0
        # every point of the body (vertices, surface and curve origins, control points): copies share all of
        # them, and unlike the vertices alone they pin down the orientation of features without vertices
        pts = []
        for b in cps:
            s = b[b.rfind(b"(") + 1:b.find(b")", b.rfind(b"("))]
            try:
                v = [float(x) for x in s.split(b",")]
            except ValueError:
                continue
            if len(v) == 3:
                pts.append(v)
        pts = np.unique(np.round(np.array(pts, float).reshape(-1, 3), 6), axis=0)
        out.append((bid, np.array(ids, np.int32), nbytes, faces, pts))
    return out


# ---------------------------------------------------------------- the model structure
class Model:
    def __init__(self, ix, P):
        self.ix = ix
        T = ix.text
        A = lambda r: args_of(T[r])
        of = lambda *t: [int(x) for x in ix.of_type(*t)]
        self.prod_name = {p: (string(A(p)[1]).strip() or string(A(p)[0]).strip()) for p in of(b"PRODUCT")}
        pdf_prod = {f: ref(A(f)[2]) for f in of(b"PRODUCT_DEFINITION_FORMATION",
                                                b"PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE")}
        self.pds = of(b"PRODUCT_DEFINITION")
        self.pd_name, self.pd_ctx = {}, None
        for d in self.pds:
            a = A(d)
            self.pd_name[d] = self.prod_name.get(pdf_prod.get(ref(a[2])), "?")
            self.pd_ctx = self.pd_ctx or ref(a[3])
        p0 = of(b"PRODUCT")
        self.prod_ctx = refs_in(A(p0[0])[3])[0] if p0 else None
        pds_of = {}
        for s in of(b"PRODUCT_DEFINITION_SHAPE"):
            pds_of[ref(A(s)[2])] = s
        reps_of_pds = {}
        for s in of(b"SHAPE_DEFINITION_REPRESENTATION"):
            a = A(s); reps_of_pds.setdefault(ref(a[0]), []).append(ref(a[1]))
        links = {}
        for s in of(b"SHAPE_REPRESENTATION_RELATIONSHIP"):
            a = A(s); r1, r2 = ref(a[2]), ref(a[3])
            links.setdefault(r1, []).append(r2); links.setdefault(r2, []).append(r1)
        # assembly links
        self.kids = {}      # parent PD -> [nauo]
        self.nauo = {}      # nauo -> (child PD, name)
        child_pds = set()
        for n in of(b"NEXT_ASSEMBLY_USAGE_OCCURRENCE"):
            a = A(n); parent, child = ref(a[3]), ref(a[4])
            self.kids.setdefault(parent, []).append(n)
            self.nauo[n] = (child, string(a[1]).strip() or string(a[0]).strip())
            child_pds.add(child)
        self.roots = [d for d in self.pds if d not in child_pds]
        # placements: CDSR(rr, pds(nauo)); rr = (REPRESENTATION_RELATIONSHIP(..,rep1,rep2) ..WITH_TRANSFORMATION(#t))
        self.sr_of_pd = {d: reps_of_pds.get(pds_of.get(d), []) for d in self.pds}
        self.xf = {}
        bad = 0
        for c in of(b"CONTEXT_DEPENDENT_SHAPE_REPRESENTATION"):
            a = A(c); rr, pds = ref(a[0]), ref(a[1])
            n = ref(A(pds)[2]) if pds in T else None
            if n not in self.nauo:
                continue
            t = T.get(rr, b"")
            m1 = re.search(rb"REPRESENTATION_RELATIONSHIP\((.*?)\)\s*REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION\(#(\d+)\)", t)
            if not m1:
                bad += 1; continue
            rep1, rep2 = refs_in(m1.group(1))[-2:]
            idt = int(m1.group(2))
            if ix.type(idt) != b"ITEM_DEFINED_TRANSFORMATION":
                bad += 1; continue
            ia = args_of(ix.body(idt)); P1, P2 = placement(ix, ref(ia[2])), placement(ix, ref(ia[3]))
            child = self.nauo[n][0]
            child_reps = set(self.sr_of_pd.get(child, []))
            self.xf[n] = P2 @ np.linalg.inv(P1) if rep1 in child_reps or rep2 not in child_reps else P1 @ np.linalg.inv(P2)
        if bad:
            P.log(f"warning: {bad} assembly placements not understood (identity used)")
        # bodies per PD: items of its shape representations and of reps linked to them
        self.bodies = {}    # PD -> [body]
        self.body_rep = {}  # body -> (rep type, context)
        for d in self.pds:
            seen, todo, out = set(), list(self.sr_of_pd[d]), []
            while todo:
                r = todo.pop()
                if r in seen or r not in T:
                    continue
                seen.add(r)
                ty = ix.type(r)
                if ty in REPS:
                    a = A(r)
                    for it in refs_in(a[1]):
                        if ix.has(it) and ix.type(it) in BODY:
                            out.append(it); self.body_rep[it] = (ty, ref(a[2]))
                todo.extend(links.get(r, []))
            self.bodies[d] = sorted(set(out))
        self.body_name = {}
        for bl in self.bodies.values():
            for b in bl:
                nm = string(args_of(ix.body(b))[0]).strip()
                self.body_name[b] = nm[:-len("-solid1")] if nm.endswith("-solid1") else nm
        # styles: item -> styled items; the presentation representation(s) that list them
        self.styled = {}
        for s in of(b"STYLED_ITEM", b"OVER_RIDING_STYLED_ITEM"):
            a = A(s)
            if len(a) > 2 and ref(a[2]) is not None:
                self.styled.setdefault(ref(a[2]), []).append(s)
        self.mdgpr = of(b"MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION")


# ---------------------------------------------------------------- writing a unit
def closure_plain(ix, seeds, stop=lambda r: False):
    out, stack, seen = [], list(seeds), set()
    while stack:
        r = stack.pop()
        if r in seen or not ix.has(r) or stop(r):
            continue
        seen.add(r); out.append(r)
        stack.extend(ix.refs(r))
    return out


def write_unit(path, ix, M, bodies, closures, cache):
    """A standalone STEP holding these bodies, each as its own root part named @@<body id>@@."""
    ids = np.unique(np.concatenate([closures[b] for b in bodies]))
    mask = np.zeros(ix.max_id + 1, bool); mask[ids] = True
    extra = []
    ctxs = {M.body_rep[b][1] for b in bodies} | {M.prod_ctx, M.pd_ctx}
    for c in ctxs:
        if c is not None:
            if c not in cache:
                cache[c] = closure_plain(ix, [c])
            extra += cache[c]
    # styles whose item is in this unit (and that don't reach geometry outside it)
    style_codes = {ix.types[t] for t in STYLE if t in ix.types}
    keep = []
    cand = {s for it, ss in M.styled.items() if it <= ix.max_id and mask[it] for s in ss}
    for s in sorted(cand):
        cl = closure_plain(ix, [s], stop=lambda r: bool(mask[r]) if r <= ix.max_id else True)
        if all(ix.tcodes[ix.row[r]] in style_codes for r in cl if r != s) and \
                all(bool(mask[ref(args_of(ix.body(r))[2])]) for r in cl if r in M.styled_set):
            keep.append(s); extra += cl
    nid = ix.max_id + 1
    synth = []
    def add(text):
        nonlocal nid
        synth.append((nid, text)); nid += 1
        return nid - 1
    for b in bodies:
        tag = f"'@@{b}@@'"
        p = add(f"PRODUCT({tag},{tag},'',(#{M.prod_ctx}))")
        f = add(f"PRODUCT_DEFINITION_FORMATION('','',#{p})")
        d = add(f"PRODUCT_DEFINITION('design','',#{f},#{M.pd_ctx})")
        s = add(f"PRODUCT_DEFINITION_SHAPE('','',#{d})")
        ty, ctx = M.body_rep[b]
        r = add(f"{ty.decode()}('',(#{b}),#{ctx})")
        add(f"SHAPE_DEFINITION_REPRESENTATION(#{s},#{r})")
    if keep:
        for g in M.mdgpr[:1]:
            a = args_of(ix.body(g))
            add(f"MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION({a[0].decode('latin-1')},"
                f"({','.join(f'#{k}' for k in keep)}),{a[2].decode()})")
    all_ids = np.unique(np.concatenate([ids, np.array(extra, np.int64)])) if extra else ids
    with open(path, "wb") as f:
        f.write(ix.header)
        f.write(b"DATA;\n")
        for r in all_ids:
            rec = ix.raw(int(r))
            f.write(rec if rec.endswith(b"\n") else rec + b"\n")
        for i, t in synth:
            f.write(f"#{i}={t};\n".encode("latin-1"))
        f.write(b"ENDSEC;\nEND-ISO-10303-21;\n")
    return len(all_ids) + len(synth)


# ---------------------------------------------------------------- glb
def read_glb(path):
    b = open(path, "rb").read()
    jl = struct.unpack_from("<I", b, 12)[0]
    g = json.loads(b[20:20 + jl])
    o = 20 + jl
    bin_ = b""
    if o < len(b):
        bl = struct.unpack_from("<I", b, o)[0]
        bin_ = b[o + 8:o + 8 + bl]
    return g, bin_


def write_glb(path, g, bin_):
    js = json.dumps(g, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    bin_ += b"\0" * (-len(bin_) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 28 + len(js) + len(bin_)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack("<II", len(bin_), 0x004E4942)); f.write(bin_)


class Merger:
    """Collects the units' meshes into one glTF and builds the node tree."""

    def __init__(self):
        self.g = {"asset": {"version": "2.0", "generator": "step2gltf --split"}, "scene": 0, "scenes": [{"nodes": []}],
                  "nodes": [], "meshes": [], "accessors": [], "bufferViews": [], "materials": [], "buffers": [{}]}
        self.bins, self.binlen = [], 0
        self.body = {}  # body id -> (B 4x4, template)
        self.ext = set()

    def add_unit(self, path):
        g, b = read_glb(path)
        pad = -self.binlen % 8
        self.bins.append(b"\0" * pad + b); off = self.binlen + pad; self.binlen = off + len(b)
        G = self.g
        bv0, ac0, me0, ma0 = len(G["bufferViews"]), len(G["accessors"]), len(G["meshes"]), len(G["materials"])
        for v in g.get("bufferViews", []):
            v = dict(v); v["buffer"] = 0; v["byteOffset"] = v.get("byteOffset", 0) + off; G["bufferViews"].append(v)
        for a in g.get("accessors", []):
            a = dict(a)
            if "bufferView" in a:
                a["bufferView"] += bv0
            G["accessors"].append(a)
        G["materials"] += g.get("materials", [])
        for m in g.get("meshes", []):
            m = json.loads(json.dumps(m))
            for p in m["primitives"]:
                p["attributes"] = {k: v + ac0 for k, v in p["attributes"].items()}
                if "indices" in p:
                    p["indices"] += ac0
                if "material" in p:
                    p["material"] += ma0
            G["meshes"].append(m)
        self.ext |= set(g.get("extensionsUsed", []))
        nodes = g.get("nodes", [])
        def tmpl(i):
            n = nodes[i]
            return {"name": n.get("name"), "M": to_mat(n), "mesh": n["mesh"] + me0 if "mesh" in n else None,
                    "children": [tmpl(c) for c in n.get("children", [])]}
        found = 0
        for r in g["scenes"][g.get("scene", 0)]["nodes"]:
            m = TAG.match(nodes[r].get("name", ""))
            if m:
                t = tmpl(r); self.body[int(m.group(1))] = (t["M"], t); found += 1
        return found

    def node(self, name, M, mesh=None, children=()):
        n = {"name": name}
        if not np.allclose(M, np.eye(4), atol=1e-12):
            n["matrix"] = [float(x) for x in M.T.reshape(-1)]
        if mesh is not None:
            n["mesh"] = mesh
        if children:
            n["children"] = list(children)
        self.g["nodes"].append(n)
        return len(self.g["nodes"]) - 1

    def copy(self, t, name=None, M=None):
        kids = [self.copy(c) for c in t["children"]]
        return self.node(name if name is not None else t["name"], t["M"] if M is None else M, t["mesh"], kids)

    def write(self, path):
        G = self.g
        G["buffers"][0]["byteLength"] = self.binlen
        if self.ext:
            G["extensionsUsed"] = sorted(self.ext)
        for k in ("materials",):
            if not G[k]:
                del G[k]
        write_glb(path, G, b"".join(self.bins))


# ---------------------------------------------------------------- run
def run(a, optimize=None):
    P = Progress(a.verbose)
    t0 = time.time()
    size = os.path.getsize(a.step)
    P.log(f"split conversion of {a.step} ({mb(size)})")

    # 1. index
    P.start("index", size, mb)
    ix = StepIndex(a.step, lambda d, t: P.update(d))
    P.end(f"indexed {ix.n:,} records")
    M = Model(ix, P)
    M.styled_set = {s for v in M.styled.values() for s in v}
    nb = sum(len(v) for v in M.bodies.values())
    P.log(f"{len(M.pds)} parts, {len(M.nauo)} placements, {nb:,} bodies")

    # include / exclude / min-size on the occurrence tree -> the bodies actually used
    def match(pats, name, path):
        import fnmatch
        return any(fnmatch.fnmatch(name.lower(), p.lower()) or fnmatch.fnmatch(path.lower(), p.lower()) for p in pats)
    keep_occ = {}  # (parent path, nauo) decisions are per path; we only need the set of used bodies here
    used = set()
    def walk(pd, path, forced):
        kept = False
        for n in M.kids.get(pd, []):
            child, name = M.nauo[n]
            p = f"{path}/{name}"
            if a.exclude and match(a.exclude, name, p):
                continue
            inc = forced or bool(a.include and match(a.include, name, p))
            if walk(child, p, inc):
                kept = True; keep_occ[p] = True
        own = forced or not a.include
        if own and M.bodies.get(pd):
            used.update(M.bodies[pd]); kept = True
        return kept
    for r in M.roots:
        walk(r, M.pd_name[r], False)
    bodies = sorted(used)

    # 2. body closures
    jobs = a.jobs or auto_jobs(a.budget)
    global _IX
    _IX = ix
    closures, nbytes, nfaces, pts = {}, {}, {}, {}
    P.start("bodies", len(bodies))
    chunks = [bodies[i:i + 64] for i in range(0, len(bodies), 64)]
    done = 0
    import multiprocessing as mp
    with mp.get_context("fork").Pool(max(1, (os.cpu_count() or 2) - 1)) as pool:
        for res in pool.imap_unordered(_closure_job, chunks):
            for bid, ids, n, f, p in res:
                closures[bid], nbytes[bid], nfaces[bid], pts[bid] = ids, n, f, p
            done += len(res); P.update(done)
    P.end(f"bodies: {mb(sum(nbytes.values()))} of geometry")

    # min-size: parts whose bodies' bounding box is smaller than N mm
    if a.min_size:
        drop = set()
        for d, bl in M.bodies.items():
            ps = [pts[b] for b in bl if b in pts and len(pts[b])]
            if ps:
                q = np.concatenate(ps)
                if np.linalg.norm(q.max(0) - q.min(0)) < a.min_size:
                    drop.update(bl)
        bodies = [b for b in bodies if b not in drop]
        P.log(f"--min-size: {len(drop):,} bodies of small parts dropped")

    # 3. copies
    dup = {}
    if a.reinstance:
        base = lambda s: re.sub(r"[-_ ]\d+$", "", s)
        owner = {b: d for d, bl in M.bodies.items() for b in bl}
        groups = {}
        for b in bodies:
            if len(pts[b]) >= 4:
                nm = M.body_name.get(b) or ""
                key = (base(nm) if nm and nm not in ("NONE", "Solid", "Solid1", "PartBody") else base(M.pd_name[owner[b]]),
                       nfaces[b], len(pts[b]))
                groups.setdefault(key, []).append(b)
        cands = [g for g in groups.values() if len(g) > 1]
        P.start("copies", sum(len(g) for g in cands))
        n = failed = 0
        for g in cands:
            canon = []
            for b in g:
                f1 = frame(pts[b])
                hit = None
                for c, f0 in canon:
                    s = solve(f0, f1, a.match_tol)
                    if s:
                        hit = (c, s); break
                if hit:
                    dup[b] = (hit[0], *hit[1])
                else:
                    failed += bool(canon); canon.append((b, f1))
                n += 1; P.update(n, f"{len(dup):,} copies")
        P.end(f"copies: {len(dup):,} bodies are copies of another (same name, shape confirmed)"
              + (f"; {failed:,} same name but a different shape (kept)" if failed else ""))
        if a.verbose:
            by = {}
            for b, (c, *_ ) in dup.items():
                by[c] = by.get(c, 0) + 1
            for c, k in sorted(by.items(), key=lambda x: -x[1])[:15]:
                P.debug(f"  {M.body_name.get(c) or M.pd_name[owner[c]]}: {k} copies")

    # 4. units
    todo = [b for b in bodies if b not in dup]
    budget = a.budget * 1e6
    units, cur, cb = [], [], 0
    for b in todo:  # bodies are in file order, so a part's bodies stay together
        if cur and cb + nbytes[b] > budget:
            units.append(cur); cur, cb = [], 0
        cur.append(b); cb += nbytes[b]
    if cur:
        units.append(cur)
    total = sum(nbytes[b] for b in todo)
    P.log(f"converting {len(todo):,} bodies ({mb(total)}) in {len(units)} units, {jobs} at a time")

    tmp = tempfile.mkdtemp(prefix="step2gltf-", dir=a.temp or None)
    here = os.path.dirname(os.path.abspath(__file__))
    cmd0 = [sys.executable, os.path.join(here, "step2gltf.py"), "convert"]
    opts = ["--deflection", str(a.deflection), "--angle", str(a.angle), "--up", a.up,
            "--no-split-bodies", "--no-reinstance", "--no-optimize"]
    merger = Merger()
    cache = {}
    failed_units = []
    seq = [0]

    def convert(units, total, phase):
        pending = [(seq[0] + k, u) for k, u in enumerate(units)]
        seq[0] += len(units)
        running = {}
        done_b = 0
        n0 = pending[0][0] if pending else 0
        P.start(phase, total, mb)
        def status():
            return f"{len(units) - len(pending) - len(running)}/{len(units)} units, {len(running)} running"
        while pending or running:
            while pending and len(running) < jobs:
                i, u = pending.pop(0)
                sp, gp, lp = (os.path.join(tmp, f"unit{i:04d}{e}") for e in (".step", ".glb", ".log"))
                write_unit(sp, ix, M, u, closures, cache)
                ub = sum(nbytes[b] for b in u)
                P.debug(f"unit {i - n0 + 1}/{len(units)}: {len(u):,} bodies, {mb(ub)} – started")
                running[i] = (subprocess.Popen(cmd0 + [sp, "-o", gp] + opts, stdout=subprocess.DEVNULL,
                                               stderr=open(lp, "wb")), u, sp, gp, lp, time.time(), ub)
                P.update(done_b, status())
            for i in list(running):
                p, u, sp, gp, lp, ts, ub = running[i]
                if p.poll() is None:
                    continue
                del running[i]
                if p.returncode != 0 or not os.path.exists(gp):
                    tail = open(lp, "rb").read().decode("utf-8", "replace").strip().splitlines()[-8:]
                    P.log(f"unit {i - n0 + 1} failed (exit {p.returncode}):\n    " + "\n    ".join(tail))
                    failed_units.append(i)
                else:
                    got = merger.add_unit(gp)
                    if got != len(u):
                        P.log(f"warning: unit {i - n0 + 1}: {len(u) - got} of {len(u)} bodies produced no mesh")
                    P.debug(f"unit {i - n0 + 1}/{len(units)} done in {dur(time.time() - ts)} ({len(u):,} bodies, {mb(ub)})")
                    if a.verbose:
                        for line in open(lp, "rb").read().decode("utf-8", "replace").splitlines():
                            if "skipped" in line or "ERR" in line or "warning" in line.lower():
                                P.debug(f"    {line.strip()}")
                    if not a.keep_temp:
                        for f in (sp, gp, lp):
                            os.remove(f)
                done_b += ub
                P.update(done_b, status())
            time.sleep(0.1)
        P.end(f"{phase}: {len(units)} units in {dur(time.time() - P.ps)}")

    convert(units, total, "convert")
    # a canonical body OCCT couldn't mesh (it happens at some positions) doesn't speak for its copies:
    # convert those copies themselves
    empty = lambda t: t["mesh"] is None and not t["children"]
    retry = [b for b, (c, *_ ) in dup.items() if c in merger.body and empty(merger.body[c][1])]
    if retry:
        for b in retry:
            del dup[b]
        P.log(f"{len(retry)} copies of bodies that gave no mesh: converting them separately")
        convert([retry], sum(nbytes[b] for b in retry), "retry")
    if failed_units:
        P.log(f"{len(failed_units)} units failed; their bodies are missing (temp files kept in {tmp})")

    # 5. merge
    P.start("merge", len(M.roots) + len(M.nauo))
    C = np.eye(4) * 0.001; C[3, 3] = 1
    if a.up == "z":
        C[:3, :3] = 0.001 * np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]])
    Ci = np.linalg.inv(C)
    conv = lambda L: C @ L @ Ci
    missing = set()
    count = [0]
    def body_of(b):
        if b in dup:
            c, R, t = dup[b]
            if c not in merger.body:
                missing.add(b); return None
            T = np.eye(4); T[:3, :3] = R; T[:3, 3] = t
            B, tm = merger.body[c]
            return conv(T) @ B, tm
        if b not in merger.body:
            missing.add(b); return None
        return merger.body[b]
    def occ(pd, name, L, path):
        count[0] += 1; P.update(count[0])
        kids = []
        for n in M.kids.get(pd, []):
            child, cname = M.nauo[n]
            p = f"{path}/{cname}"
            if a.exclude and match(a.exclude, cname, p):
                continue
            if a.include and p not in keep_occ:
                continue
            k = occ(child, cname, conv(M.xf.get(n, np.eye(4))), p)
            if k is not None:
                kids.append(k)
        bl = [b for b in M.bodies.get(pd, []) if b in set_bodies]
        mesh = None
        got = [(b, body_of(b)) for b in bl]
        got = [(b, x) for b, x in got if x]
        if len(bl) == 1 and not M.kids.get(pd) and got:
            B, t = got[0][1]
            L = L @ B; mesh = t["mesh"]; kids += [merger.copy(c) for c in t["children"]]
        else:
            for i, (b, (B, t)) in enumerate(got, 1):
                nm = M.body_name.get(b) or f"{M.pd_name[pd]} body {bl.index(b) + 1}"
                kids.append(merger.copy(t, nm, B))
        if not kids and mesh is None:
            return None
        return merger.node(name, L, mesh, kids)
    set_bodies = set(bodies)
    for r in M.roots:
        k = occ(r, M.pd_name[r], np.eye(4), M.pd_name[r])
        if k is not None:
            merger.g["scenes"][0]["nodes"].append(k)
    P.end()
    if missing:
        P.log(f"warning: {len(missing):,} bodies have no mesh (failed unit or empty geometry)")
    out = a.output
    merger.write(out)
    P.log(f"wrote {out}: {len(merger.g['nodes']):,} nodes, {len(merger.g['meshes']):,} meshes, {mb(os.path.getsize(out))}")
    if a.optimize and optimize:
        optimize(out)
        P.log(f"dedup: {mb(os.path.getsize(out))}")
    if not a.keep_temp and not failed_units:
        try:
            os.rmdir(tmp)
        except OSError:
            pass
    P.log(f"done in {dur(time.time() - t0)}")


def auto_jobs(budget_mb):
    """As many children as fit in ~60% of RAM (a unit takes roughly 10x its STEP text), at most cores - 1."""
    try:
        ram = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError):
        ram = 8e9
    per = max(budget_mb * 10e6, 1e9)
    return max(1, min((os.cpu_count() or 2) - 1, int(ram * 0.6 / per)))
