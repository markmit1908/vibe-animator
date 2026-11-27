# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["cadquery-ocp>=7.7", "numpy", "scipy"]
# ///
"""
STEP -> glTF (.glb) converter for the refuelling viewer, using OpenCASCADE (OCP).

Keeps the assembly hierarchy, part names and colours. Converts mm -> m and Z-up -> Y-up.
Big plant models: use `tree` first, then filter with --include/--exclude/--min-size.
Very big files (GBs; OCCT would need more memory than the machine has): `convert --split`.

  uv run tools/step2gltf.py tree    data/model.step [--depth 3]
  uv run tools/step2gltf.py audit   data/model.step > data/audit.md
  uv run tools/step2gltf.py convert data/model.step -o public/cad/model.glb \
        [--include 'Vessel*' ...] [--exclude '*Screw*' ...] [--min-size 50] \
        [--deflection 2] [--angle 20] [--up z|y]
  uv run tools/step2gltf.py convert huge.step -o out.glb --split [-v] [--jobs N] [--budget 200]

--split indexes the STEP text without loading it into OCCT, finds duplicate bodies (same name and
shape, placed elsewhere – they become instances), converts the rest in parallel units of at most
--budget MB of STEP text, and merges them into one .glb with the full assembly tree. A progress bar
shows each phase; -v also logs each unit and the largest groups of copies. See tools/stepsplit.py.

Patterns are fnmatch globs (case-insensitive) matched against each component's
name and its full path ("Top/Sub/Part"). --include keeps matching subtrees (and
their ancestors); --exclude drops matching subtrees; --min-size drops parts whose
bounding-box diagonal is below N mm (fasteners, magnets, etc.).
"""
import argparse, faulthandler, fnmatch, sys, time
faulthandler.enable()  # OCCT crashes otherwise exit silently
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString, TCollection_AsciiString
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ShapeTool
from OCP.TDF import TDF_LabelSequence, TDF_Label
from OCP.TDataStd import TDataStd_Name
from OCP.IFSelect import IFSelect_RetDone
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.RWGltf import RWGltf_CafWriter
from OCP.RWMesh import RWMesh_CoordinateSystem, RWMesh_NameFormat
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
from OCP.TColStd import TColStd_IndexedDataMapOfStringString
from OCP.Message import Message_ProgressRange

ST = XCAFDoc_ShapeTool


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, file=sys.stderr, flush=True)


def load(path):
    log(f"reading {path} (large files take minutes)…")
    doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    r = STEPCAFControl_Reader()
    r.SetColorMode(True); r.SetNameMode(True); r.SetLayerMode(False)
    if r.ReadFile(path) != IFSelect_RetDone:
        sys.exit("failed to read STEP")
    r.Transfer(doc)
    log("read done")
    global READER
    READER = r
    return doc, XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())


READER = None


def step_name(shape):
    """Name of the STEP entity a shape was read from (e.g. a body's MANIFOLD_SOLID_BREP name)."""
    if READER is None:
        return ""
    try:
        tr = READER.ChangeReader().WS().TransferReader()
        ent = tr.EntityFromShapeResult(shape, 1) or tr.EntityFromShapeResult(shape, -1)
        if ent is not None and hasattr(ent, "Name") and ent.Name() is not None:
            return ent.Name().ToCString().strip()
    except Exception:
        pass
    return ""


def name_of(label):
    attr = TDataStd_Name()
    if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
        return attr.Get().ToExtString().strip()
    return "?"


def referred(label):
    if ST.IsReference_s(label):
        ref = TDF_Label()
        ST.GetReferredShape_s(label, ref)
        return ref
    return label


def children(label):
    seq = TDF_LabelSequence()
    if ST.IsAssembly_s(label):
        ST.GetComponents_s(label, seq, False)
    return [seq.Value(i) for i in range(1, seq.Length() + 1)]


_size_cache = {}
def size_mm(proto):
    key = proto.Tag()
    if key not in _size_cache:
        box = Bnd_Box()
        BRepBndLib.Add_s(ST.GetShape_s(proto), box)
        _size_cache[key] = 0.0 if box.IsVoid() else box.SquareExtent() ** 0.5
    return _size_cache[key]


def roots(st):
    seq = TDF_LabelSequence()
    st.GetFreeShapes(seq)
    return [seq.Value(i) for i in range(1, seq.Length() + 1)]


def cmd_tree(st, depth):
    def walk(label, path, d):
        proto = referred(label)
        kids = children(proto)
        # group identical siblings by name
        groups = {}
        for k in kids:
            groups.setdefault(name_of(referred(k)), []).append(k)
        for n, ks in groups.items():
            p = referred(ks[0])
            sub = len(children(p))
            print(f"{'  ' * d}{n}  x{len(ks)}  {size_mm(p):.0f}mm" + (f"  [{sub} children]" if sub else ""))
            if d + 1 < depth:
                walk(ks[0], f"{path}/{n}", d + 1)
    for r in roots(st):
        print(f"{name_of(r)}  {size_mm(r):.0f}mm")
        walk(r, name_of(r), 1)


def match(patterns, name, path):
    return any(fnmatch.fnmatch(name.lower(), p.lower()) or fnmatch.fnmatch(path.lower(), p.lower()) for p in patterns)


def cmd_convert(doc, st, a):
    removed = kept_parts = 0

    def prune(label, path, forced):
        """Returns True if this subtree keeps anything."""
        nonlocal removed, kept_parts
        proto = referred(label)
        kids = children(proto)
        if not kids:  # leaf part
            ok = forced or not a.include
            if ok and a.min_size and size_mm(proto) < a.min_size:
                ok = False
            kept_parts += ok
            return ok
        any_kept = False
        for k in kids:
            n = name_of(referred(k))
            p = f"{path}/{n}"
            if a.exclude and match(a.exclude, n, p):
                st.RemoveComponent(k); removed += 1; continue
            inc = forced or (a.include and match(a.include, n, p))
            if prune(k, p, inc):
                any_kept = True
            else:
                st.RemoveComponent(k); removed += 1
        return any_kept

    orig_roots = {r.Tag() for r in roots(st)}
    for r in roots(st):
        prune(r, name_of(r), False)
    st.UpdateAssemblies()
    if a.split_bodies:
        split_bodies(st)
    if a.reinstance:
        reinstance(st, a.match_tol)
    # parts whose every instance was removed become free shapes; drop them so they aren't exported
    while True:
        orphans = [r for r in roots(st) if r.Tag() not in orig_roots]
        if not orphans:
            break
        for o in orphans:
            st.RemoveShape(o, True)
        st.UpdateAssemblies()
    log(f"pruned {removed} components; ~{kept_parts} part instances kept")

    # every component gets a readable instance name (OCCT's default is "=>[0:1:1:7]")
    seq = TDF_LabelSequence(); st.GetShapes(seq)
    for i in range(1, seq.Length() + 1):
        for k in children(seq.Value(i)):
            TDataStd_Name.Set_s(k, TCollection_ExtendedString(instance_name(k)))

    # mesh each remaining simple shape once (instances share the mesh)
    seq = TDF_LabelSequence()
    st.GetShapes(seq)
    n = 0
    for i in range(1, seq.Length() + 1):
        l = seq.Value(i)
        if ST.IsSimpleShape_s(l):
            BRepMesh_IncrementalMesh(ST.GetShape_s(l), a.deflection, False, a.angle * 3.14159 / 180, True)
            n += 1
            if n % 200 == 0:
                log(f"meshed {n} shapes")
    log(f"meshed {n} shapes; writing {a.output}")

    w = RWGltf_CafWriter(TCollection_AsciiString(a.output), a.output.endswith(".glb"))
    w.SetMergeFaces(True)  # one primitive per part instead of one per B-rep face (draw calls!)
    w.SetNodeNameFormat(RWMesh_NameFormat.RWMesh_NameFormat_InstanceOrProduct)
    w.SetMeshNameFormat(RWMesh_NameFormat.RWMesh_NameFormat_Product)
    conv = w.ChangeCoordinateSystemConverter()
    conv.SetInputLengthUnit(0.001)
    conv.SetInputCoordinateSystem(RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Zup if a.up == "z"
                                  else RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Yup)
    conv.SetOutputLengthUnit(1.0)
    conv.SetOutputCoordinateSystem(RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_glTF)
    if not w.Perform(doc, TColStd_IndexedDataMapOfStringString(), Message_ProgressRange()):
        sys.exit("glTF write failed")
    if a.optimize:
        optimize(a.output)
    log("done")


def optimize(path):
    """Share identical meshes (dedup). The `instance` pass is deliberately not used:
    it moves instanced nodes to the scene root and drops their names, destroying the
    assembly tree the viewer relies on."""
    import os, subprocess
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for step in ("dedup",):
        log(f"gltf-transform {step}")
        subprocess.run(["npx", "gltf-transform", step, path, path], cwd=root, check=True,
                       stdout=subprocess.DEVNULL)


def cmd_audit(st, tol):
    """Report names shared by geometrically different parts, plus other model hygiene issues."""
    # instance counts per prototype (multiplied through nested assemblies)
    counts = {}
    def walk(label, mult):
        for k in children(referred(label)):
            p = referred(k)
            counts[p.Tag()] = counts.get(p.Tag(), 0) + mult
            walk(k, mult)
    for r in roots(st):
        counts[r.Tag()] = 1
        walk(r, 1)

    seq = TDF_LabelSequence(); st.GetShapes(seq)
    protos = [seq.Value(i) for i in range(1, seq.Length() + 1)]
    log(f"measuring {len(protos)} prototypes…")
    info, by_name = {}, {}
    for i, l in enumerate(protos):
        shp = ST.GetShape_s(l)
        box = Bnd_Box(); BRepBndLib.Add_s(shp, box)
        dims = (0, 0, 0)
        if not box.IsVoid():
            x0, y0, z0, x1, y1, z1 = box.Get(); dims = tuple(sorted((x1 - x0, y1 - y0, z1 - z0)))
        asm = ST.IsAssembly_s(l)
        vol = faces = solids = area = 0
        moments = (0, 0, 0)
        if not asm:
            g = GProp_GProps(); BRepGProp.VolumeProperties_s(shp, g); vol = g.Mass()
            ga = GProp_GProps(); BRepGProp.SurfaceProperties_s(shp, ga); area = ga.Mass()
            try:  # principal moments: orientation-independent shape fingerprint
                pm = g.PrincipalProperties()
                m = pm.Moments()
                moments = tuple(sorted(m)) if isinstance(m, tuple) else moments
            except Exception:
                pass
            e = TopExp_Explorer(shp, TopAbs_FACE)
            while e.More(): faces += 1; e.Next()
            e = TopExp_Explorer(shp, TopAbs_SOLID)
            while e.More(): solids += 1; e.Next()
        n = name_of(l)
        info[l.Tag()] = dict(name=n, asm=asm, dims=dims, vol=vol, area=area, moments=moments, faces=faces, solids=solids,
                             n=counts.get(l.Tag(), 0), kids=len(children(l)))
        by_name.setdefault(n, []).append(l.Tag())
        if (i + 1) % 500 == 0:
            log(f"  {i + 1}/{len(protos)}")

    def sig(d):
        """Orientation-independent geometry signature (rounded to tolerance).
        Rotated/moved copies of the same part match; genuinely different parts don't."""
        r = lambda v: round(v / tol)
        if d["asm"]:
            return (True, d["kids"], r(sum(d["dims"])))  # assemblies: child count + rough size
        root = lambda v: abs(v) ** (1 / 3) if v else 0
        return (False, d["faces"], r(root(d["vol"])), r(d["area"] ** 0.5),
                *(r(m ** 0.2) for m in d["moments"]))

    def fmt(d):
        dm = "x".join(f"{v:.0f}" for v in d["dims"])
        kind = f"assembly[{d['kids']}]" if d["asm"] else f"{d['faces']} faces, {d['vol'] / 1e3:.1f} cm3"
        return f"{dm} mm, {kind}, used x{d['n']}"

    print("# STEP audit\n")
    print("## Same name, genuinely different geometry\n")
    clash = 0
    for n, tags in sorted(by_name.items()):
        groups = {}
        for t in tags:
            groups.setdefault(sig(info[t]), []).append(t)
        if len(groups) > 1:
            clash += 1
            print(f"- **{n}**: {len(groups)} distinct shapes")
            for g in groups.values():
                print(f"    - {fmt(info[g[0]])}" + (f"  ({len(g)} copies, not instanced)" if len(g) > 1 else ""))
    print(f"\n{clash} clashing names\n")

    print("## Same part stored as separate copies (geometry baked in place, not instanced)\n")
    dup = 0
    for n, tags in sorted(by_name.items()):
        groups = {}
        for t in tags:
            groups.setdefault(sig(info[t]), []).append(t)
        for g in groups.values():
            if len(g) > 1:
                dup += 1
                print(f"- **{n}**: {len(g)} copies — {fmt(info[g[0]])}")
    print(f"\n{dup} names\n")

    print("## Other issues\n")
    for t, d in info.items():
        probs = []
        if d["name"] in ("?", ""): probs.append("unnamed")
        if not d["asm"] and d["solids"] == 0: probs.append("no solids (surface/wire only)")
        if not d["asm"] and d["vol"] < 0: probs.append("negative volume (inverted)")
        if d["dims"] == (0, 0, 0): probs.append("empty")
        if probs and d["n"]:
            print(f"- {d['name']}: {', '.join(probs)} — {fmt(d)}")



# ---------------------------------------------------------------- multi-body parts
# A STEP part can hold many solid bodies (Shapr3D exports a "part" with 308 named
# bodies, e.g. V-005738-001_A). Turn such parts into an assembly with one component
# per body, named from the STEP body names, so each body is its own node/mesh.

def split_bodies(st):
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopLoc import TopLoc_Location
    seq = TDF_LabelSequence(); st.GetShapes(seq)
    labels = [seq.Value(i) for i in range(1, seq.Length() + 1)]
    users = {}
    for l in labels:
        for k in children(l):
            users.setdefault(referred(k).Tag(), []).append((l, k))
    split = bodies = named_n = 0
    log(f"split: scanning {len(labels)} shapes for multi-body parts…")
    for l in labels:
        if not ST.IsSimpleShape_s(l) or l.Tag() not in users:
            continue
        shp = ST.GetShape_s(l)
        solids = []
        e = TopExp_Explorer(shp, TopAbs_SOLID)
        while e.More(): solids.append(e.Current()); e.Next()
        if len(solids) < 2:
            continue
        log(f"  {name_of(l)}: {len(solids)} bodies")
        # body names live on sub-shape labels
        # body names come from the STEP entities (reading XCAF sub-shape labels segfaults in OCP)
        part_name = name_of(l)
        asm = st.NewShape()
        TDataStd_Name.Set_s(asm, TCollection_ExtendedString(part_name))
        for i, so in enumerate(solids, 1):
            nm = step_name(so) or f"{part_name} body {i}"
            nm = nm[:-len("-solid1")] if nm.endswith("-solid1") else nm
            body = st.AddShape(so, False)
            TDataStd_Name.Set_s(body, TCollection_ExtendedString(nm))
            c = st.AddComponent(asm, body, TopLoc_Location())
            TDataStd_Name.Set_s(c, TCollection_ExtendedString(nm))
            named_n += not nm.startswith(f"{part_name} body ")
        for parent, comp in users[l.Tag()]:
            loc, cname = ST.GetLocation_s(comp), instance_name(comp)
            st.RemoveComponent(comp)
            c = st.AddComponent(parent, asm, loc)
            TDataStd_Name.Set_s(c, TCollection_ExtendedString(cname))
        split += 1; bodies += len(solids)
    st.UpdateAssemblies()
    log(f"split {split} multi-body parts into {bodies} bodies ({named_n} named from STEP)")


def instance_name(comp):
    """Name to show for a component: its own instance name, else its part's name."""
    n = name_of(comp)
    return n if n not in ("?", "") and not n.startswith("=>") else name_of(referred(comp))


# ---------------------------------------------------------------- re-instancing
# Some exporters (Shapr3D) write every copy of a part as its own shape with the
# placement baked into the geometry. We find identical shapes, solve the rigid
# transform canonical -> copy from principal axes of inertia, verify it on the
# B-rep vertices, and re-point each component at the canonical shape.

def _frame(shp):
    import numpy as np
    from OCP.TopAbs import TopAbs_VERTEX
    from OCP.BRep import BRep_Tool
    from OCP.TopoDS import TopoDS
    g = GProp_GProps(); BRepGProp.VolumeProperties_s(shp, g)
    ga = GProp_GProps(); BRepGProp.SurfaceProperties_s(shp, ga)
    c = g.CentreOfMass(); pm = g.PrincipalProperties()
    mom = np.array(pm.Moments())
    axes = np.array([[v.X(), v.Y(), v.Z()] for v in
                     (pm.FirstAxisOfInertia(), pm.SecondAxisOfInertia(), pm.ThirdAxisOfInertia())]).T
    order = np.argsort(mom)
    pts = []
    e = TopExp_Explorer(shp, TopAbs_VERTEX)
    while e.More():
        p = BRep_Tool.Pnt_s(TopoDS.Vertex_s(e.Current())); pts.append((p.X(), p.Y(), p.Z())); e.Next()
    pts = np.unique(np.round(np.array(pts).reshape(-1, 3), 6), axis=0)
    nf = 0
    e = TopExp_Explorer(shp, TopAbs_FACE)
    while e.More(): nf += 1; e.Next()
    return dict(c=np.array([c.X(), c.Y(), c.Z()]), mom=mom[order], axes=axes[:, order],
                pts=pts, vol=g.Mass(), area=ga.Mass(), faces=nf)


def _candidates(f0, f1, tol):
    """Rotation candidates R with f1 ~= R f0 (det +1)."""
    import numpy as np
    A0, A1, m = f0["axes"], f1["axes"], f0["mom"]
    rel = lambda a, b: abs(a - b) <= 1e-4 * max(abs(a), abs(b), 1e-9)
    out = []
    import itertools
    for s in itertools.product((1, -1), repeat=3):  # OCCT axes may be left-handed
        R = A1 @ np.diag(s) @ A0.T
        if np.linalg.det(R) > 0:
            out.append(R)
    # axisymmetric part: principal axes in the degenerate plane are arbitrary.
    deg = [i for i in range(2) if rel(m[i], m[i + 1])]
    if deg and len(f0["pts"]):
        u_i = 2 if deg[0] == 0 else 0
        p0 = f0["pts"] - f0["c"]; p1 = f1["pts"] - f1["c"]
        for su in (1, -1):
            u0 = A0[:, u_i]; u1 = A1[:, u_i] * su
            r0 = None
            # reference vertex: farthest from the axis
            r0 = p0 - np.outer(p0 @ u0, u0); k = np.argmax(np.linalg.norm(r0, axis=1))
            h0, d0 = p0[k] @ u0, np.linalg.norm(r0[k])
            if d0 < tol:
                continue
            r1 = p1 - np.outer(p1 @ u1, u1)
            match = np.where((np.abs(p1 @ u1 - h0) < tol * 4) & (np.abs(np.linalg.norm(r1, axis=1) - d0) < tol * 4))[0]
            for j in match[:24]:
                a0 = r0[k] / d0; b0 = np.cross(u0, a0)
                a1 = r1[j] / np.linalg.norm(r1[j]); b1 = np.cross(u1, a1)
                out.append(np.column_stack([a1, b1, u1]) @ np.column_stack([a0, b0, u0]).T)
    return out


def _solve(f0, f1, tol):
    import numpy as np
    from scipy.spatial import cKDTree
    if len(f0["pts"]) != len(f1["pts"]):
        return None
    tree = cKDTree(f1["pts"]) if len(f1["pts"]) else None
    for R in _candidates(f0, f1, tol):
        t = f1["c"] - R @ f0["c"]
        if tree is not None:
            d, _ = tree.query(f0["pts"] @ R.T + t)
            if d.max() > tol:
                continue
        return R, t
    return None


def _trsf(R, t):
    from OCP.gp import gp_Trsf
    T = gp_Trsf()
    T.SetValues(R[0, 0], R[0, 1], R[0, 2], t[0], R[1, 0], R[1, 1], R[1, 2], t[1], R[2, 0], R[2, 1], R[2, 2], t[2])
    return T


def reinstance(st, tol):
    from OCP.TopLoc import TopLoc_Location
    # components referencing each simple prototype
    seq = TDF_LabelSequence(); st.GetShapes(seq)
    labels = [seq.Value(i) for i in range(1, seq.Length() + 1)]
    users = {}
    for l in labels:
        for k in children(l):
            users.setdefault(referred(k).Tag(), []).append((l, k))
    simple = [l for l in labels if ST.IsSimpleShape_s(l) and l.Tag() in users]
    log(f"re-instancing: fingerprinting {len(simple)} parts…")
    frames, groups = {}, {}
    q = lambda v: round(v / tol) if tol else v
    for i, l in enumerate(simple):
        f = frames[l.Tag()] = _frame(ST.GetShape_s(l))
        # abs(): inverted/degenerate bodies can report negative volume or area
        key = (f["faces"], len(f["pts"]), round(abs(f["vol"]) ** (1 / 3) * 1000), round(abs(f["area"]) ** 0.5 * 100))
        groups.setdefault(key, []).append(l)
        if (i + 1) % 1000 == 0:
            log(f"  {i + 1}/{len(simple)}")
    merged = failed = 0
    for members in groups.values():
        if len(members) < 2:
            continue
        canon_list = []  # several canonicals if the group holds genuinely different shapes
        for l in members:
            f1 = frames[l.Tag()]
            hit = None
            for c in canon_list:
                sol = _solve(frames[c.Tag()], f1, tol)
                if sol:
                    hit = (c, sol); break
            if not hit:
                if canon_list:
                    failed += 1
                canon_list.append(l)
                continue
            c, (R, t) = hit
            T = TopLoc_Location(_trsf(R, t))
            for parent, comp in users[l.Tag()]:
                loc, cname = ST.GetLocation_s(comp).Multiplied(T), instance_name(comp)
                st.RemoveComponent(comp)
                nc = st.AddComponent(parent, c, loc)
                TDataStd_Name.Set_s(nc, TCollection_ExtendedString(cname))
            merged += 1
    st.UpdateAssemblies()
    log(f"re-instancing: {merged} copies now instance a shared part"
        + (f"; {failed} look alike but did not verify (kept separate)" if failed else ""))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("tree"); t.add_argument("step"); t.add_argument("--depth", type=int, default=3)
    au = sub.add_parser("audit"); au.add_argument("step")
    au.add_argument("--tol", type=float, default=0.5, help="geometry match tolerance, mm")
    c = sub.add_parser("convert"); c.add_argument("step"); c.add_argument("-o", "--output", required=True)
    c.add_argument("--include", nargs="*", default=[]); c.add_argument("--exclude", nargs="*", default=[])
    c.add_argument("--min-size", type=float, default=0, help="drop parts smaller than N mm (bbox diagonal)")
    c.add_argument("--deflection", type=float, default=1.0, help="mesh chord tolerance, mm")
    c.add_argument("--angle", type=float, default=20, help="mesh angular tolerance, degrees")
    c.add_argument("--up", choices=["z", "y"], default="z", help="up axis of the STEP model")
    c.add_argument("--no-split-bodies", dest="split_bodies", action="store_false",
                   help="keep multi-body parts as one mesh (default: one child per solid body)")
    c.add_argument("--no-reinstance", dest="reinstance", action="store_false",
                   help="don't rebuild instancing for copies baked in place")
    c.add_argument("--match-tol", type=float, default=0.05, help="vertex match tolerance for re-instancing, mm")
    c.add_argument("--no-optimize", dest="optimize", action="store_false",
                   help="skip the gltf-transform dedup pass")
    c.add_argument("--split", action="store_true",
                   help="low-memory mode for very big files: index, drop copies, convert in parallel units, merge")
    c.add_argument("--jobs", type=int, default=0, help="--split: units converted at once (default: what fits in RAM)")
    c.add_argument("--budget", type=float, default=200, help="--split: STEP text per unit, MB (memory per job ~10x)")
    c.add_argument("--temp", default="", help="--split: folder for the unit files (default: system temp)")
    c.add_argument("--keep-temp", action="store_true", help="--split: keep each unit's .step/.glb/.log")
    c.add_argument("-v", "--verbose", action="store_true", help="--split: log every unit and the copies found")
    a = ap.parse_args()
    if a.cmd == "convert" and a.split:
        sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
        import stepsplit
        stepsplit.run(a, optimize)
        return
    doc, st = load(a.step)
    if a.cmd == "tree":
        cmd_tree(st, a.depth)
    elif a.cmd == "audit":
        cmd_audit(st, a.tol)
    else:
        cmd_convert(doc, st, a)


if __name__ == "__main__":
    main()
