import importlib.util
import io
import pathlib
import unittest
import zipfile
from docx import Document

script = pathlib.Path(__file__).resolve().parents[1] / 'resources/runtime-scripts/merge_office.py'
spec = importlib.util.spec_from_file_location('office_merge', script)
merge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(merge)


def package(document):
    stream = io.BytesIO()
    document.save(stream)
    with zipfile.ZipFile(stream, 'a') as archive:
        archive.writestr('custom/unknown.bin', b'untouched unknown part\x00\xff')
        archive.writestr('word/vbaProject.bin', b'opaque macro bytes\x00\xff')
    return stream.getvalue()


def entries(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {item.filename: item for item in archive.infolist()}


class OfficeMergeTest(unittest.TestCase):
    def setUp(self):
        doc = Document()
        doc.add_paragraph('original first')
        doc.add_paragraph('original second')
        table = doc.add_table(rows=1, cols=2)
        table.cell(0, 0).text = 'left'
        table.cell(0, 1).text = 'right'
        doc.sections[0].header.paragraphs[0].text = 'Keep header'
        self.a = package(doc)

    def variant(self, update):
        doc = Document(io.BytesIO(self.a))
        update(doc)
        return package(doc)

    def test_disjoint_paragraphs_and_cells_preserve_package_parts(self):
        def local(doc):
            doc.paragraphs[0].text = 'private first'
            doc.tables[0].cell(0, 0).text = 'private left'
        def shared(doc):
            doc.paragraphs[1].text = 'shared second'
            doc.tables[0].cell(0, 1).text = 'shared right'
        result, detail = merge.merge_package(self.a, self.variant(local), self.variant(shared), 'docx')
        doc = Document(io.BytesIO(result))
        self.assertEqual([p.text for p in doc.paragraphs], ['private first', 'shared second'])
        self.assertEqual([c.text for c in doc.tables[0].rows[0].cells], ['private left', 'shared right'])
        self.assertEqual(detail['mergedParts'], ['word/document.xml'])
        base, out = entries(self.a), entries(result)
        for name, item in base.items():
            if name != 'word/document.xml':
                self.assertEqual(out[name].compress_type, item.compress_type, name)
                with zipfile.ZipFile(io.BytesIO(self.a)) as a, zipfile.ZipFile(io.BytesIO(result)) as output:
                    self.assertEqual(output.read(name), a.read(name), name)
        self.assertEqual(list(out)[0], '[Content_Types].xml')

    def test_same_paragraph_conflicts(self):
        def change(value):
            return self.variant(lambda doc: setattr(doc.paragraphs[0], 'text', value))
        with self.assertRaises(merge.MergeConflict) as caught:
            merge.merge_docx(self.a, change('private'), change('remote'))
        self.assertEqual(caught.exception.reason, 'same_paragraph')

    def test_insertion_beside_a_disjoint_edit_merges(self):
        local = self.variant(lambda doc: doc.add_paragraph('new paragraph'))
        shared = self.variant(lambda doc: setattr(doc.paragraphs[0], 'text', 'remote'))
        result = merge.merge_docx(self.a, local, shared)
        self.assertEqual([p.text for p in Document(io.BytesIO(result)).paragraphs], ['remote', 'original second', 'new paragraph'])

    def test_both_sides_inserting_at_the_same_place_conflicts(self):
        local = self.variant(lambda doc: doc.add_paragraph('local addition'))
        shared = self.variant(lambda doc: doc.add_paragraph('shared addition'))
        with self.assertRaises(merge.MergeConflict) as caught:
            merge.merge_docx(self.a, local, shared)
        self.assertEqual(caught.exception.reason, 'overlapping_changes')

    def test_duplicate_entries_refused(self):
        stream = io.BytesIO(self.a)
        with zipfile.ZipFile(stream, 'a') as archive:
            archive.writestr('word/document.xml', b'<bad/>')
        with self.assertRaises(merge.UnsupportedPackage):
            merge.merge_docx(stream.getvalue(), self.a, self.a)

    def replace_part(self, name, value, data=None):
        stream = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(data or self.a)) as source, zipfile.ZipFile(stream, 'w') as target:
            for part in source.namelist():
                target.writestr(part, value if part == name else source.read(part))
        return stream.getvalue()

    def test_opaque_part_conflict_preserves_both_inputs(self):
        with self.assertRaises(merge.MergeConflict) as caught:
            merge.merge_docx(self.a, self.replace_part('custom/unknown.bin', b'local'),
                             self.replace_part('custom/unknown.bin', b'remote'))
        self.assertEqual((caught.exception.reason, caught.exception.part), ('opaque_part', 'custom/unknown.bin'))

    def test_macro_part_from_one_side_is_kept_verbatim(self):
        result = merge.merge_docx(self.a, self.replace_part('word/vbaProject.bin', b'new macro bytes\x00'),
                                  self.variant(lambda doc: setattr(doc.paragraphs[1], 'text', 'shared')))
        with zipfile.ZipFile(io.BytesIO(result)) as output:
            self.assertEqual(output.read('word/vbaProject.bin'), b'new macro bytes\x00')

    def test_entities_and_path_traversal_are_refused(self):
        evil = b'<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><x>&secret;</x>'
        with self.assertRaises(merge.UnsupportedPackage):
            merge.merge_docx(self.replace_part('word/document.xml', evil), self.a, self.a)
        stream = io.BytesIO(self.a)
        with zipfile.ZipFile(stream, 'a') as archive:
            archive.writestr('../escape', b'bad')
        with self.assertRaises(merge.UnsupportedPackage):
            merge.merge_docx(stream.getvalue(), self.a, self.a)

    def test_relationship_edits_merge_from_one_side_only(self):
        with zipfile.ZipFile(io.BytesIO(self.a)) as archive:
            rels = archive.read('word/_rels/document.xml.rels')
        one_sided = merge.merge_docx(self.a, self.replace_part('word/_rels/document.xml.rels', rels + b'\n'), self.a)
        with zipfile.ZipFile(io.BytesIO(one_sided)) as output:
            self.assertEqual(output.read('word/_rels/document.xml.rels'), rels + b'\n')
        with self.assertRaises(merge.MergeConflict) as caught:
            merge.merge_docx(self.a, self.replace_part('word/_rels/document.xml.rels', rels + b'\n'),
                             self.replace_part('word/_rels/document.xml.rels', rels + b'\n\n'))
        self.assertEqual(caught.exception.reason, 'relationships')

    def test_metadata_parts_never_block_a_content_merge(self):
        with zipfile.ZipFile(io.BytesIO(self.a)) as archive:
            core = archive.read('docProps/core.xml')
        local = self.replace_part('docProps/core.xml', core.replace(b'</cp:coreProperties>', b'<!--local--></cp:coreProperties>'),
                                  self.variant(lambda doc: setattr(doc.paragraphs[0], 'text', 'private')))
        shared = self.replace_part('docProps/core.xml', core.replace(b'</cp:coreProperties>', b'<!--shared--></cp:coreProperties>'),
                                   self.variant(lambda doc: setattr(doc.paragraphs[1], 'text', 'shared')))
        result, detail = merge.merge_package(self.a, local, shared, 'docx')
        self.assertEqual([p.text for p in Document(io.BytesIO(result)).paragraphs], ['private', 'shared'])
        self.assertEqual(detail['metadataFromLocal'], ['docProps/core.xml'])

    def test_signed_packages_and_member_limits_refused(self):
        for name, value in [('_xmlsignatures/sig1.xml', b'<signature/>'),
                            ('custom/large.bin', b'x' * (8 * 1024 * 1024 + 1))]:
            stream = io.BytesIO(self.a)
            with zipfile.ZipFile(stream, 'a', compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr(name, value)
            with self.assertRaises(merge.UnsupportedPackage):
                merge.merge_docx(stream.getvalue(), self.a, self.a)


class WorkbookMergeTest(unittest.TestCase):
    def setUp(self):
        import openpyxl
        book = openpyxl.Workbook()
        sheet = book.active
        sheet.title = 'Budget'
        for row, (item, amount) in enumerate([('rent', 100), ('power', 40), ('water', 12)], start=1):
            sheet.cell(row=row, column=1, value=item)
            sheet.cell(row=row, column=2, value=amount)
        sheet['C1'] = '=B1*2'
        book.create_sheet('Notes')['A1'] = 'original note'
        self.a = self.save(book)

    def save(self, book):
        stream = io.BytesIO()
        book.save(stream)
        return stream.getvalue()

    def variant(self, update):
        import openpyxl
        book = openpyxl.load_workbook(io.BytesIO(self.a))
        update(book)
        return self.save(book)

    def load(self, data):
        import openpyxl
        return openpyxl.load_workbook(io.BytesIO(data))

    def test_disjoint_cells_formulas_and_appended_rows_merge(self):
        def local(book):
            book['Budget']['A1'] = 'rent (private)'
            book['Budget']['B2'] = 45
            book['Budget'].append(['gas', 30])
        def shared(book):
            book['Budget']['B3'] = 15
            book['Budget']['C3'] = '=B3*2'
            book['Notes']['A1'] = 'shared note'
        result, detail = merge.merge_package(self.a, self.variant(local), self.variant(shared), 'xlsx')
        book = self.load(result)
        sheet = book['Budget']
        self.assertEqual([sheet[ref].value for ref in ('A1', 'B2', 'B3', 'C1', 'C3', 'A4', 'B4')],
                         ['rent (private)', 45, 15, '=B1*2', '=B3*2', 'gas', 30])
        self.assertEqual(book['Notes']['A1'].value, 'shared note')
        self.assertTrue(book.calculation.fullCalcOnLoad)
        self.assertGreaterEqual(detail['cells'], 4)
        self.assertTrue(detail['recalculateOnLoad'])
        self.assertIn('xl/worksheets/sheet1.xml', detail['mergedParts'])

    def test_same_cell_and_same_formula_conflict(self):
        for update_local, update_shared in [
            (lambda b: b['Budget'].__setitem__('B1', 110), lambda b: b['Budget'].__setitem__('B1', 120)),
            (lambda b: b['Budget'].__setitem__('C1', '=B1*3'), lambda b: b['Budget'].__setitem__('C1', '=B1+1')),
        ]:
            with self.assertRaises(merge.MergeConflict) as caught:
                merge.merge_package(self.a, self.variant(update_local), self.variant(update_shared), 'xlsx')
            self.assertEqual((caught.exception.reason, caught.exception.part), ('same_cell', 'xl/worksheets/sheet1.xml'))

    def test_row_insertion_and_deletion_are_structural_conflicts(self):
        inserted = self.variant(lambda b: b['Budget'].insert_rows(2))
        deleted = self.variant(lambda b: b['Budget'].delete_rows(2))
        edited = self.variant(lambda b: b['Budget'].__setitem__('B3', 99))
        for side in (inserted, deleted):
            with self.assertRaises(merge.MergeConflict) as caught:
                merge.merge_package(self.a, side, edited, 'xlsx')
            self.assertEqual(caught.exception.reason, 'row_structure')

    def test_both_sides_appending_rows_conflict(self):
        with self.assertRaises(merge.MergeConflict) as caught:
            merge.merge_package(self.a, self.variant(lambda b: b['Budget'].append(['gas', 30])),
                                self.variant(lambda b: b['Budget'].append(['phone', 20])), 'xlsx')
        self.assertEqual(caught.exception.reason, 'appended_rows')

    def parts(self, data):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            return {name: archive.read(name) for name in archive.namelist()}

    def test_one_sided_change_is_taken_verbatim(self):
        changed = self.variant(lambda b: b['Budget'].__setitem__('B1', 110))
        self.assertEqual(self.parts(merge.merge_package(self.a, changed, self.a, 'xlsx')[0]), self.parts(changed))
        self.assertEqual(self.parts(merge.merge_package(self.a, self.a, changed, 'xlsx')[0]), self.parts(changed))


class PresentationMergeTest(unittest.TestCase):
    def setUp(self):
        from pptx import Presentation
        deck = Presentation()
        for title in ('Slide one', 'Slide two'):
            slide = deck.slides.add_slide(deck.slide_layouts[1])
            slide.shapes.title.text = title
            slide.placeholders[1].text = 'body'
        self.a = self.save(deck)

    def save(self, deck):
        stream = io.BytesIO()
        deck.save(stream)
        return stream.getvalue()

    def variant(self, update):
        from pptx import Presentation
        deck = Presentation(io.BytesIO(self.a))
        update(deck)
        return self.save(deck)

    def titles(self, data):
        from pptx import Presentation
        return [slide.shapes.title.text for slide in Presentation(io.BytesIO(data)).slides]

    def test_disjoint_slide_edits_merge_and_one_side_may_add_a_slide(self):
        def local(deck):
            deck.slides[0].shapes.title.text = 'Private one'
        def shared(deck):
            deck.slides[1].shapes.title.text = 'Shared two'
            slide = deck.slides.add_slide(deck.slide_layouts[1])
            slide.shapes.title.text = 'Shared three'
        result, detail = merge.merge_package(self.a, self.variant(local), self.variant(shared), 'pptx')
        self.assertEqual(self.titles(result), ['Private one', 'Shared two', 'Shared three'])
        self.assertIn('ppt/slides/slide1.xml', detail['changedParts'])

    def test_same_slide_edits_conflict(self):
        with self.assertRaises(merge.MergeConflict) as caught:
            merge.merge_package(self.a, self.variant(lambda d: setattr(d.slides[0].shapes.title, 'text', 'A')),
                                self.variant(lambda d: setattr(d.slides[0].shapes.title, 'text', 'B')), 'pptx')
        self.assertEqual((caught.exception.reason, caught.exception.part), ('opaque_part', 'ppt/slides/slide1.xml'))

    def test_both_sides_adding_slides_conflict(self):
        add = lambda title: (lambda d: setattr(d.slides.add_slide(d.slide_layouts[1]).shapes.title, 'text', title))
        with self.assertRaises(merge.MergeConflict):
            merge.merge_package(self.a, self.variant(add('L')), self.variant(add('S')), 'pptx')


if __name__ == '__main__':
    unittest.main()
