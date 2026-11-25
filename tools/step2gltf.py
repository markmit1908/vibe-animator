# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["cadquery-ocp>=7.7"]
# ///
"""
STEP -> glTF (.glb) converter for the refuelling viewer, using OpenCASCADE (OCP).

Keeps the assembly hierarchy, part names and colours. Converts mm -> m and Z-up -> Y-up.
Big plant models: use `tree` first, then filter with --include/--exclude/--min-size.

  uv run tools/step2gltf.py tree    data/model.step [--depth 3]
  uv run tools/step2gltf.py audit   data/model.step > data/audit.md
  uv run tools/step2gltf.py convert data/model.step -o public/cad/model.glb \
        [--include 'Vessel*' ...] [--exclude '*Screw*' ...] [--min-size 50] \
        [--deflection 2] [--angle 20] [--up z|y]

Patterns are fnmatch globs (case-insensitive) matched against each component's
name and its full path ("Top/Sub/Part"). --include keeps matching subtrees (and
their ancestors); --exclude drops matching subtrees; --min-size drops parts whose
bounding-box diagonal is below N mm (fasteners, magnets, etc.).
"""
import argparse, fnmatch, sys, time
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
    return doc, XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())


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
    # parts whose every instance was removed become free shapes; drop them so they aren't exported
    while True:
        orphans = [r for r in roots(st) if r.Tag() not in orig_roots]
        if not orphans:
            break
        for o in orphans:
            st.RemoveShape(o, True)
        st.UpdateAssemblies()
    log(f"pruned {removed} components; ~{kept_parts} part instances kept")

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
    w.SetNodeNameFormat(RWMesh_NameFormat.RWMesh_NameFormat_ProductOrInstance)
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
    """Share identical meshes (dedup) and turn repeated nodes into GPU instances."""
    import os, subprocess
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for step in ("dedup", "instance"):
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
    c.add_argument("--no-optimize", dest="optimize", action="store_false",
                   help="skip the gltf-transform dedup + GPU-instancing pass")
    a = ap.parse_args()
    doc, st = load(a.step)
    if a.cmd == "tree":
        cmd_tree(st, a.depth)
    elif a.cmd == "audit":
        cmd_audit(st, a.tol)
    else:
        cmd_convert(doc, st, a)


if __name__ == "__main__":
    main()
