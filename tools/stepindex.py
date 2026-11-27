"""
Low-memory STEP (ISO 10303-21) index: one streaming pass records each entity's byte offset, length and type.
Small structural records (products, assembly links, representations, styles) are kept as text; geometry is
read back on demand through an mmap. Pure Python + numpy (no OCCT), so it can scan files far larger than RAM
allows OCCT to load.
"""
import mmap, re, sys, time
import numpy as np

REF = re.compile(rb"#(\d+)")
# record types kept in memory (everything that builds the product structure, transforms and styles)
STRUCT = {
    b"PRODUCT", b"PRODUCT_DEFINITION", b"PRODUCT_DEFINITION_FORMATION", b"PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE",
    b"PRODUCT_DEFINITION_SHAPE", b"SHAPE_DEFINITION_REPRESENTATION", b"SHAPE_REPRESENTATION",
    b"SHAPE_REPRESENTATION_RELATIONSHIP", b"NEXT_ASSEMBLY_USAGE_OCCURRENCE", b"CONTEXT_DEPENDENT_SHAPE_REPRESENTATION",
    b"ITEM_DEFINED_TRANSFORMATION", b"MAPPED_ITEM", b"REPRESENTATION_MAP", b"DRAUGHTING_MODEL", b"STYLED_ITEM",
    b"OVER_RIDING_STYLED_ITEM", b"MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION",
    b"ADVANCED_BREP_SHAPE_REPRESENTATION", b"MANIFOLD_SURFACE_SHAPE_REPRESENTATION",
    b"FACETED_BREP_SHAPE_REPRESENTATION", b"GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION",
    b"GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION", b"EDGE_BASED_WIREFRAME_SHAPE_REPRESENTATION",
    b"TESSELLATED_SHAPE_REPRESENTATION", b"PRESENTATION_LAYER_ASSIGNMENT", b"PRODUCT_RELATED_PRODUCT_CATEGORY",
    b"PROPERTY_DEFINITION", b"PROPERTY_DEFINITION_REPRESENTATION", b"REPRESENTATION", b"GENERAL_PROPERTY_ASSOCIATION",
    b"SHAPE_ASPECT", b"MANIFOLD_SOLID_BREP", b"BREP_WITH_VOIDS", b"SHELL_BASED_SURFACE_MODEL",
}
COMPLEX = b"("  # type code for complex entities "(A()B()…)"; their text is kept too (units, contexts, transforms)


def now():
    return time.strftime("%H:%M:%S")


class StepIndex:
    def __init__(self, path, progress=None):
        self.path = path
        self.f = open(path, "rb")
        self.mm = mmap.mmap(self.f.fileno(), 0, access=mmap.ACCESS_READ)
        self.header = b""
        self.text = {}  # id -> record text (structural records only)
        self.types = {}  # type name -> code
        self._scan(progress)

    # ------------------------------------------------------------ scan
    def _scan(self, progress):
        mm, size = self.mm, len(self.mm)
        data = mm.find(b"\nDATA;")
        if data < 0:
            raise ValueError("no DATA section")
        self.header = mm[:data + 1]
        pos = data + len(b"\nDATA;") + 1
        ids, offs, lens, tcodes = (np.empty(1 << 20, t) for t in (np.int64, np.int64, np.int32, np.int16))
        n = 0
        types, text = self.types, self.text
        tnames = []
        last = time.time()
        start = pos
        rd = mm.readline
        mm.seek(pos)
        buf = None; bstart = 0
        while True:
            lstart = mm.tell()
            line = rd()
            if not line:
                break
            if buf is not None:  # continuing a multi-line record
                buf += line
            else:
                if not line.startswith(b"#"):
                    if line.startswith(b"ENDSEC"):
                        break
                    continue
                buf = line; bstart = lstart
            s = buf.rstrip()
            if not s.endswith(b";") or s.count(b"'") % 2:  # unfinished (or ';' inside a string)
                continue
            rec = buf; buf = None
            eq = rec.find(b"=")
            try:
                rid = int(rec[1:eq])
            except ValueError:
                continue
            j = eq + 1
            while rec[j:j + 1] in (b" ", b"\t"):
                j += 1
            if rec[j:j + 1] == b"(":
                tname = COMPLEX
            else:
                k = rec.find(b"(", j)
                tname = rec[j:k].strip()
            code = types.get(tname)
            if code is None:
                code = types[tname] = len(tnames); tnames.append(tname)
            if n == len(ids):
                ids, offs, lens, tcodes = (np.resize(a, 2 * n) for a in (ids, offs, lens, tcodes))
            ids[n] = rid; offs[n] = bstart; lens[n] = len(rec); tcodes[n] = code; n += 1
            if tname in STRUCT or tname == COMPLEX:
                text[rid] = bytes(rec[eq + 1:]).strip().rstrip(b";")
            if progress and (n & 0xFFFF) == 0:
                t = time.time()
                if t - last > 0.2:
                    progress(mm.tell() - start, size - start); last = t
        if progress:
            progress(size - start, size - start)
        ids, offs, lens, tcodes = ids[:n], offs[:n], lens[:n], tcodes[:n]
        self.n = n
        self.max_id = int(ids.max()) if n else 0
        self.row = np.full(self.max_id + 1, -1, np.int32)  # id -> row
        self.row[ids] = np.arange(n, dtype=np.int32)
        self.ids, self.offs, self.lens, self.tcodes = ids, offs, lens, tcodes
        self.tnames = tnames

    # ------------------------------------------------------------ access
    def has(self, rid):
        return 0 <= rid <= self.max_id and self.row[rid] >= 0

    def raw(self, rid):
        """Full record line(s) as in the file, e.g. b"#12=CARTESIAN_POINT('',(0.,0.,0.));\\n"."""
        r = self.row[rid]
        o = int(self.offs[r])
        return self.mm[o:o + int(self.lens[r])]

    def body(self, rid):
        """Text after '=' without the trailing ';'."""
        t = self.text.get(rid)
        if t is not None:
            return t
        rec = self.raw(rid)
        return bytes(rec[rec.find(b"=") + 1:]).strip().rstrip(b";")

    def type(self, rid):
        return self.tnames[self.tcodes[self.row[rid]]]

    def refs(self, rid):
        return [int(m) for m in REF.findall(self.body(rid))]

    def of_type(self, *names):
        codes = [self.types[n] for n in names if n in self.types]
        if not codes:
            return np.empty(0, np.int64)
        return self.ids[np.isin(self.tcodes, codes)]


# ---------------------------------------------------------------- argument parsing
def args_of(body):
    """Split 'TYPE(a,b,(c,d),'x,y')' into the top-level argument strings (bytes). Complex entities aren't split."""
    i = body.find(b"(")
    s = body[i + 1:body.rfind(b")")]
    out, depth, cur, q = [], 0, bytearray(), False
    for ch in s:
        c = bytes((ch,))
        if q:
            cur += c
            if c == b"'":
                q = False
            continue
        if c == b"'":
            q = True; cur += c
        elif c == b"(":
            depth += 1; cur += c
        elif c == b")":
            depth -= 1; cur += c
        elif c == b"," and depth == 0:
            out.append(bytes(cur).strip()); cur = bytearray()
        else:
            cur += c
    out.append(bytes(cur).strip())
    return out


def ref(a):
    return int(a[1:]) if a.startswith(b"#") else None


def refs_in(a):
    return [int(m) for m in REF.findall(a)]


def string(a):
    """Decode a STEP string argument ('…', with '' escapes and \\X2\\…\\X0\\ unicode)."""
    if not a.startswith(b"'"):
        return ""
    s = a[1:-1].replace(b"''", b"'").decode("latin-1")
    def x2(m):
        h = m.group(1)
        return "".join(chr(int(h[i:i + 4], 16)) for i in range(0, len(h), 4))
    s = re.sub(r"\\X2\\([0-9A-Fa-f]+)\\X0\\", x2, s)
    s = re.sub(r"\\X\\([0-9A-Fa-f]{2})", lambda m: chr(int(m.group(1), 16)), s)
    return s


if __name__ == "__main__":
    t = time.time()
    ix = StepIndex(sys.argv[1], lambda a, b: print(f"\r{a / b:6.1%}", end="", file=sys.stderr))
    print(f"\n{ix.n} records, {len(ix.text)} kept, {time.time() - t:.1f}s", file=sys.stderr)
    import resource
    print("maxrss MB", resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6, file=sys.stderr)
    if len(sys.argv) > 2:  # dump the structural neighbourhood of one record
        seen = set()
        def dump(rid, d):
            if rid in seen or d > int(sys.argv[3] if len(sys.argv) > 3 else 6):
                return
            seen.add(rid)
            print("  " * d + f"#{rid}=" + ix.body(rid)[:200].decode("latin-1"))
            for r in ix.refs(rid):
                dump(r, d + 1)
        dump(int(sys.argv[2]), 0)
