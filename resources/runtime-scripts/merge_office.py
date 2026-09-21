"""Conservative three-way merge for OOXML packages (Word, Excel, PowerPoint and
their macro-enabled variants). Opaque OPC parts are never reserialized: they
are chosen whole from one side or reported as conflicts. Only the typed main
content parts get structural merging, and every result is re-validated with the
read-only reader of its format before it is written."""
import copy
import difflib
import hashlib
import io
import json
import os
import re
import stat
import sys
import unicodedata
import zipfile

from lxml import etree

POLICY = 'office-parts-v2'
LIMIT = 64 * 1024 * 1024
FORMATS = {'.docx': 'docx', '.docm': 'docx', '.xlsx': 'xlsx', '.xlsm': 'xlsx', '.pptx': 'pptx', '.pptm': 'pptx'}
MAIN = {'docx': 'word/document.xml', 'xlsx': 'xl/workbook.xml', 'pptx': 'ppt/presentation.xml'}
WORD = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
SHEET = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
CELL_REF = re.compile(r'^([A-Z]{1,3})([1-9][0-9]{0,6})$')


class MergeConflict(Exception):
    def __init__(self, reason='content', part=None):
        super().__init__(reason)
        self.reason, self.part = reason, part


class UnsupportedPackage(Exception):
    pass


def xml(data):
    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False,
                             huge_tree=False, remove_blank_text=False)
    tree = etree.parse(io.BytesIO(data), parser)
    if tree.docinfo.doctype or any(isinstance(node, etree._Entity) for node in tree.iter()):
        raise UnsupportedPackage()
    return tree.getroot()


def serialize(node):
    return etree.tostring(node, xml_declaration=True, encoding='UTF-8', standalone=True)


def validate(data, fmt):
    """Read-only format validation with the library of the format; never save through it."""
    if fmt == 'docx':
        from docx import Document
        Document(io.BytesIO(data))
    elif fmt == 'xlsx':
        import openpyxl
        openpyxl.load_workbook(io.BytesIO(data), read_only=True, keep_links=False).close()
    elif fmt == 'pptx':
        from pptx import Presentation
        Presentation(io.BytesIO(data))
    else:
        raise UnsupportedPackage()


class Package:
    def __init__(self, data, fmt):
        if len(data) > LIMIT:
            raise UnsupportedPackage()
        self.parts, self.infos, self.order = {}, {}, []
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                if len(entries) > 4096 or sum(item.file_size for item in entries) > LIMIT:
                    raise UnsupportedPackage()
                names = set()
                for item in entries:
                    name = item.filename
                    key = unicodedata.normalize('NFC', name).casefold()
                    if (key in names or key.startswith('_xmlsignatures/') or '\\' in name or '\x00' in name or
                            name.startswith('/') or any(p in ('', '.', '..') for p in name.split('/')) or
                            ':' in name or item.flag_bits & 1 or item.file_size > 8 * 1024 * 1024 or
                            stat.S_ISLNK(item.external_attr >> 16)):
                        raise UnsupportedPackage()
                    names.add(key)
                    self.parts[name] = archive.read(item)
                    self.infos[name] = item
                    self.order.append(name)
                    if name.endswith(('.xml', '.rels')):
                        xml(self.parts[name])
            if MAIN[fmt] not in self.parts:
                raise UnsupportedPackage()
            validate(data, fmt)
        except UnsupportedPackage:
            raise
        except Exception as error:
            raise UnsupportedPackage() from error


def choose(a, w, m):
    if w == m or a == m:
        return w
    if a == w:
        return m
    raise MergeConflict()


def merge_sequence(a, w, m, element_merge=None):
    """Three-way merge of sibling sequences keyed by serialization. Touching or
    overlapping hunks conflict unless both sides replaced the same range one for
    one and each pair can be merged structurally."""
    key = lambda items: [etree.tostring(node) for node in items]
    ka, kw, km = key(a), key(w), key(m)
    if kw == km or ka == km:
        return [copy.deepcopy(node) for node in w]
    if ka == kw:
        return [copy.deepcopy(node) for node in m]
    def hunks(kb, ks, side):
        # Equal-length replacements split into positional element pairs so a
        # changed paragraph next to a changed table does not swallow both.
        result = []
        for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, kb, ks, autojunk=False).get_opcodes():
            if tag == 'equal':
                continue
            if tag == 'replace' and i2 - i1 == j2 - j1:
                result.extend((i1 + k, i1 + k + 1, side[j1 + k:j1 + k + 1]) for k in range(i2 - i1))
            else:
                result.append((i1, i2, side[j1:j2]))
        return result
    hw, hm = hunks(ka, kw, w), hunks(ka, km, m)
    merged, pos = [], 0
    ordered = sorted([(h, 'w') for h in hw] + [(h, 'm') for h in hm], key=lambda item: (item[0][0], item[0][1]))
    index = 0
    while index < len(ordered):
        (i1, i2, replacement), side = ordered[index]
        nxt = ordered[index + 1] if index + 1 < len(ordered) else None
        # Distinct sibling ranges may touch (adjacent paragraphs edited by
        # different sides). Overlap, or the same range on both sides, conflicts
        # unless both replaced it one for one and each pair merges structurally.
        if nxt and (nxt[0][0] < i2 or (nxt[0][0], nxt[0][1]) == (i1, i2)):
            (n1, n2, other), other_side = nxt
            if (n1, n2) == (i1, i2) and i2 > i1 and len(replacement) == len(other) == i2 - i1 and element_merge and side != other_side:
                merged.extend(a[pos:i1])
                for triple in zip(a[i1:i2], replacement if side == 'w' else other, other if side == 'w' else replacement):
                    merged.append(element_merge(*triple))
                pos = i2
                index += 2
                continue
            raise MergeConflict('overlapping_changes')
        merged.extend(a[pos:i1])
        merged.extend(copy.deepcopy(node) for node in replacement)
        pos = i2
        index += 1
    merged.extend(a[pos:])
    return [copy.deepcopy(node) for node in merged]


def merge_node(a, w, m):
    ser = lambda node: etree.tostring(node)
    try:
        selected = choose(ser(a), ser(w), ser(m))
        return copy.deepcopy(w if selected == ser(w) else m)
    except MergeConflict:
        pass
    # Paragraphs and cells are atomic. Never infer run/field/formula semantics.
    containers = {WORD + name for name in ('document', 'body', 'tbl', 'tr')}
    if a.tag not in containers or a.tag != w.tag or a.tag != m.tag:
        raise MergeConflict('same_paragraph')
    result = copy.deepcopy(a)
    result.text = choose(a.text, w.text, m.text)
    result.tail = choose(a.tail, w.tail, m.tail)
    result.attrib.clear()
    for key in set(a.attrib) | set(w.attrib) | set(m.attrib):
        value = choose(a.get(key), w.get(key), m.get(key))
        if value is not None:
            result.set(key, value)
    for child in list(result):
        result.remove(child)
    for child in merge_sequence(list(a), list(w), list(m), merge_node):
        result.append(child)
    return result


def cell_column_row(ref):
    match = CELL_REF.match(ref or '')
    if not match:
        raise UnsupportedPackage()
    column = 0
    for letter in match.group(1):
        column = column * 26 + ord(letter) - 64
    return column, int(match.group(2))


def shared_strings(parts):
    data = parts.get('xl/sharedStrings.xml')
    return list(xml(data)) if data else []


def inline(cell, strings):
    """Resolve a shared-string reference into an inline string so a cell taken
    from one side never points into another side's string table."""
    cell = copy.deepcopy(cell)
    if cell.get('t') == 's':
        value = cell.find(SHEET + 'v')
        index = int(value.text) if value is not None and value.text and value.text.isdigit() else -1
        if not 0 <= index < len(strings):
            raise UnsupportedPackage()
        cell.remove(value)
        cell.set('t', 'inlineStr')
        holder = etree.SubElement(cell, SHEET + 'is')
        for child in strings[index]:
            holder.append(copy.deepcopy(child))
    return cell


def sheet_model(parts, name):
    root = xml(parts[name])
    strings = shared_strings(parts)
    data = root.find(SHEET + 'sheetData')
    if data is None:
        raise UnsupportedPackage()
    rows, cells = {}, {}
    for row in data:
        if row.tag != SHEET + 'row':
            raise UnsupportedPackage()
        number = int(row.get('r') or 0)
        if number <= 0 or number in rows:
            raise UnsupportedPackage()
        header = copy.deepcopy(row)
        for child in list(header):
            header.remove(child)
        rows[number] = etree.tostring(header)
        for cell in row:
            if cell.tag != SHEET + 'c':
                raise UnsupportedPackage()
            column, cell_row = cell_column_row(cell.get('r'))
            if cell_row != number or (column, cell_row) in cells:
                raise UnsupportedPackage()
            cells[(column, cell_row)] = inline(cell, strings)
    others = [child for child in root if child.tag != SHEET + 'sheetData']
    return root, rows, cells, others


def merge_sheet(parts_a, parts_w, parts_m, name):
    """Cell-level three-way merge on stable coordinates. Sides may change or add
    cells in existing rows and append rows after the last base row; deleting or
    inserting rows shifts identities and is a conflict for this sheet."""
    (root_a, rows_a, cells_a, others_a) = sheet_model(parts_a, name)
    (root_w, rows_w, cells_w, others_w) = sheet_model(parts_w, name)
    (root_m, rows_m, cells_m, others_m) = sheet_model(parts_m, name)
    last = max(rows_a) if rows_a else 0
    for rows in (rows_w, rows_m):
        if not set(rows_a) <= set(rows) or any(number < last for number in set(rows) - set(rows_a)):
            raise MergeConflict('row_structure', name)
    new_w, new_m = set(rows_w) - set(rows_a), set(rows_m) - set(rows_a)
    if new_w & new_m:
        raise MergeConflict('appended_rows', name)
    ser = lambda node: etree.tostring(node) if node is not None else None
    merged_cells, changed, formulas = {}, 0, False
    for key in set(cells_a) | set(cells_w) | set(cells_m):
        a, w, m = cells_a.get(key), cells_w.get(key), cells_m.get(key)
        try:
            selected = choose(ser(a), ser(w), ser(m))
        except MergeConflict:
            raise MergeConflict('same_cell', name)
        if selected is None:
            continue
        source = a if selected == ser(a) else w if selected == ser(w) else m
        if source is not a:
            changed += 1
            formula = source.find(SHEET + 'f')
            if formula is not None:
                formulas = True
                if formula.get('t') == 'shared':
                    raise MergeConflict('shared_formula', name)
        merged_cells[key] = copy.deepcopy(source)
    merged_rows = {}
    for number in set(rows_a) | set(rows_w) | set(rows_m):
        try:
            merged_rows[number] = xml(choose(rows_a.get(number), rows_w.get(number), rows_m.get(number)))
        except MergeConflict:
            raise MergeConflict('row_attributes', name)
    key_of = lambda node: etree.tostring(node)
    try:
        others = merge_sequence(others_a, others_w, others_m)
    except MergeConflict:
        raise MergeConflict('sheet_structure', name)
    result = copy.deepcopy(root_a)
    for child in list(result):
        result.remove(child)
    data = None
    for child in others:
        result.append(child)
    data = etree.Element(SHEET + 'sheetData')
    for number in sorted(merged_rows):
        row = merged_rows[number]
        for (column, cell_row) in sorted(k for k in merged_cells if k[1] == number):
            row.append(merged_cells[(column, cell_row)])
        data.append(row)
    # sheetData keeps its schema position: after sheetFormatPr/cols, before everything else.
    position = 0
    before = {SHEET + n for n in ('sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols')}
    for index, child in enumerate(list(result)):
        if child.tag in before:
            position = index + 1
    result.insert(position, data)
    return serialize(result), changed, formulas


def cells_from_cell(node):
    return node


def merge_package(base, local, shared, fmt):
    a, w, m = (Package(data, fmt) for data in (base, local, shared))
    names = a.parts.keys() | w.parts.keys() | m.parts.keys()
    output, sources, changed_parts, report = {}, {}, [], {'cells': 0, 'paragraphs': 0}
    formulas = False
    for name in sorted(names):
        values = [pkg.parts.get(name) for pkg in (a, w, m)]
        try:
            value = choose(*values)
            source = 'a' if value == values[0] else 'w' if value == values[1] else 'm'
        except MergeConflict:
            if name.startswith('docProps/') and all(values):
                # Application metadata (modified time, editor) is not document
                # content; the private side's copy is kept and reported.
                value, source = values[1], 'w'
                report.setdefault('metadataFromLocal', []).append(name)
            elif any(value is None for value in values):
                raise MergeConflict('part_presence', name)
            elif fmt == 'docx' and name == 'word/document.xml':
                node = merge_node(*map(xml, values))
                value, source = serialize(node), 'merged'
                report['paragraphs'] += 1
            elif fmt == 'xlsx' and name.startswith('xl/worksheets/sheet') and name.endswith('.xml'):
                value, count, has_formulas = merge_sheet(a.parts, w.parts, m.parts, name)
                source = 'merged'
                report['cells'] += count
                formulas = formulas or has_formulas
            elif name.endswith('.rels') or name == '[Content_Types].xml':
                raise MergeConflict('relationships', name)
            else:
                raise MergeConflict('opaque_part', name)
        if value is not None:
            output[name], sources[name] = value, source
            if source != 'a':
                changed_parts.append(name)
    if fmt == 'xlsx' and any(name.startswith('xl/worksheets/') and sources.get(name) == 'merged' for name in output):
        # Cached results of formulas taken from one side may be stale relative to
        # the other side's cells: drop the calculation chain and force a full
        # recalculation on open instead of guessing values.
        if 'xl/calcChain.xml' in output:
            del output['xl/calcChain.xml']
            types = xml(output['[Content_Types].xml'])
            for override in list(types):
                if override.get('PartName') == '/xl/calcChain.xml':
                    types.remove(override)
            output['[Content_Types].xml'] = serialize(types)
            rels = xml(output['xl/_rels/workbook.xml.rels'])
            for rel in list(rels):
                if rel.get('Target') in ('calcChain.xml', '/xl/calcChain.xml'):
                    rels.remove(rel)
            output['xl/_rels/workbook.xml.rels'] = serialize(rels)
        workbook = xml(output['xl/workbook.xml'])
        calc = workbook.find(SHEET + 'calcPr')
        if calc is None:
            calc = etree.SubElement(workbook, SHEET + 'calcPr')
        calc.set('fullCalcOnLoad', '1')
        output['xl/workbook.xml'] = serialize(workbook)
    order = [name for name in a.order if name in output] + [name for name in sorted(output) if name not in a.order]
    if '[Content_Types].xml' in order:
        order.remove('[Content_Types].xml')
        order.insert(0, '[Content_Types].xml')
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as archive:
        for name in order:
            origin = {'a': a, 'w': w, 'm': m}.get(sources[name], a)
            template = origin.infos.get(name) or a.infos.get(name) or w.infos.get(name) or m.infos.get(name)
            info = zipfile.ZipInfo(name, date_time=template.date_time if template else (1980, 1, 1, 0, 0, 0))
            info.compress_type = template.compress_type if template else zipfile.ZIP_DEFLATED
            info.external_attr = template.external_attr if template else 0o600 << 16
            archive.writestr(info, output[name])
    result = stream.getvalue()
    Package(result, fmt)
    return result, {'format': fmt, 'changedParts': changed_parts[:64], 'mergedParts': [n for n in output if sources[n] == 'merged'],
                    'cells': report['cells'], 'paragraphs': report['paragraphs'], 'recalculateOnLoad': formulas,
                    'metadataFromLocal': report.get('metadataFromLocal', [])}


def merge_docx(base, local, shared):
    return merge_package(base, local, shared, 'docx')[0]


def main():
    try:
        if len(sys.argv) != 5:
            raise UnsupportedPackage()
        fmt = FORMATS.get(os.path.splitext(sys.argv[4])[1].lower())
        if not fmt:
            raise UnsupportedPackage()
        inputs = []
        for name in sys.argv[1:4]:
            with open(name, 'rb') as source:
                inputs.append(source.read(LIMIT + 1))
        result, detail = merge_package(*inputs, fmt)
        fd = os.open(sys.argv[4], os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'wb') as target:
            target.write(result)
        print(json.dumps({'state': 'resolved', 'policy': POLICY, 'sha256': hashlib.sha256(result).hexdigest(),
                          'sizeBytes': len(result), **detail}))
    except MergeConflict as conflict:
        print(json.dumps({'state': 'conflict', 'policy': POLICY, 'reason': conflict.reason, 'part': conflict.part}))
    except Exception:
        print(json.dumps({'state': 'unsupported', 'policy': POLICY}))


if __name__ == '__main__':
    main()
