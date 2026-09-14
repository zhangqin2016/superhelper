"""Conservative DOCX three-way merge; opaque OPC parts are never reserialized."""
import copy
import hashlib
import io
import json
import os
import stat
import sys
import unicodedata
import zipfile

from docx import Document
from lxml import etree

LIMIT = 64 * 1024 * 1024
WORD = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


class MergeConflict(Exception):
    pass


class UnsupportedPackage(Exception):
    pass


def xml(data):
    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False,
                             huge_tree=False, remove_blank_text=False)
    tree = etree.parse(io.BytesIO(data), parser)
    if tree.docinfo.doctype or any(isinstance(node, etree._Entity) for node in tree.iter()):
        raise UnsupportedPackage()
    return tree.getroot()


def unpack(data):
    if len(data) > LIMIT:
        raise UnsupportedPackage()
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 4096 or sum(item.file_size for item in entries) > LIMIT:
                raise UnsupportedPackage()
            parts, names = {}, set()
            for item in entries:
                name = item.filename
                key = unicodedata.normalize('NFC', name).casefold()
                if (key in names or key.startswith('_xmlsignatures/') or '\\' in name or '\x00' in name or
                        name.startswith('/') or any(p in ('', '.', '..') for p in name.split('/')) or
                        ':' in name or item.flag_bits & 1 or item.file_size > 8 * 1024 * 1024 or
                        stat.S_ISLNK(item.external_attr >> 16)):
                    raise UnsupportedPackage()
                names.add(key)
                parts[name] = archive.read(item)
                if name.endswith(('.xml', '.rels')):
                    xml(parts[name])
        if 'word/document.xml' not in parts:
            raise UnsupportedPackage()
        Document(io.BytesIO(data))  # Read-only format validation; never save through this library.
        return parts
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


def merge_node(a, w, m):
    serialize = lambda node: etree.tostring(node)
    try:
        selected = choose(serialize(a), serialize(w), serialize(m))
        return copy.deepcopy(w if selected == serialize(w) else m)
    except MergeConflict:
        pass
    # Paragraphs and cells are atomic. Never infer run/field/formula semantics.
    containers = {WORD + name for name in ('document', 'body', 'tbl', 'tr')}
    if a.tag not in containers or a.tag != w.tag or a.tag != m.tag:
        raise MergeConflict()
    if not len(a) == len(w) == len(m):
        raise MergeConflict()
    if [n.tag for n in a] != [n.tag for n in w] or [n.tag for n in a] != [n.tag for n in m]:
        raise MergeConflict()
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
    for children in zip(a, w, m):
        result.append(merge_node(*children))
    return result


def merge_docx(base, local, shared):
    a, w, m = map(unpack, (base, local, shared))
    # Relationship edits can change the meaning of otherwise disjoint XML
    # references. This policy does not yet reconcile those identities.
    for name in a.keys() | w.keys() | m.keys():
        if name.endswith('.rels') or name == '[Content_Types].xml':
            if not a.get(name) == w.get(name) == m.get(name):
                raise MergeConflict()
    output = {}
    for name in sorted(a.keys() | w.keys() | m.keys()):
        values = [parts.get(name) for parts in (a, w, m)]
        try:
            value = choose(*values)
        except MergeConflict:
            if name != 'word/document.xml' or any(value is None for value in values):
                raise
            node = merge_node(*map(xml, values))
            value = etree.tostring(node, xml_declaration=True, encoding='UTF-8', standalone=True)
        if value is not None:
            output[name] = value
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, value in output.items():
            archive.writestr(name, value)
    result = stream.getvalue()
    unpack(result)
    return result


def main():
    try:
        if len(sys.argv) != 5:
            raise UnsupportedPackage()
        inputs = []
        for name in sys.argv[1:4]:
            with open(name, 'rb') as source:
                inputs.append(source.read(LIMIT + 1))
        result = merge_docx(*inputs)
        fd = os.open(sys.argv[4], os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        with os.fdopen(fd, 'wb') as target:
            target.write(result)
        print(json.dumps({'state': 'resolved', 'policy': 'docx-parts-v1',
                          'sha256': hashlib.sha256(result).hexdigest(), 'sizeBytes': len(result)}))
    except MergeConflict:
        print(json.dumps({'state': 'conflict'}))
    except Exception:
        print(json.dumps({'state': 'unsupported'}))


if __name__ == '__main__':
    main()
