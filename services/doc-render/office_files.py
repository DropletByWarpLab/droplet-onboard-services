"""Bounded OOXML inspection and surgical revisions; originals never change.

No Office executable, macros, embedded objects, network resolution or storage.
ZIP parts not edited are copied byte-for-byte, preserving native charts/styles.
Formula-bearing names, validation rules, tables and extensions share the same
network/XLM refusal guard. Flat Word fields are checked after concatenating
instruction runs; nested or malformed fields are unsupported because their
dynamic instructions cannot be resolved safely without executing Word.
"""
from __future__ import annotations
import io
import math
import posixpath
import re
import zipfile
from lxml import etree as ET
from openpyxl.utils.cell import range_boundaries, coordinate_to_tuple

MAX_INPUT_BYTES = 10 * 1024 * 1024
MAX_EXPANDED_BYTES = 30 * 1024 * 1024
MAX_PART_BYTES = 8 * 1024 * 1024
MAX_ITEMS = 200
MAX_TEXT = 80_000
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
R = "http://schemas.openxmlformats.org/package/2006/relationships"
OR = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
CELL = re.compile(r"([A-Z]{1,3})([1-9][0-9]{0,6})\Z")
FORMULA_TAGS = frozenset({"f", "fmla", "formula", "formula1", "formula2", "definedname", "calculatedcolumnformula", "totalsrowformula"})
AUTO_MACRO_NAMES = frozenset({"auto_open", "auto_close", "auto_activate", "auto_deactivate"})
UNSAFE_FORMULA_FUNCTION = re.compile(r"\b(?:WEBSERVICE|RTD|CALL|REGISTER(?:\.ID)?|EXEC(?:UTE)?|EVALUATE|RUN|SEND\.KEYS|SQL\.REQUEST|FOPEN|FREAD|FWRITE|FCLOSE|HYPERLINK|IMAGE|STOCKHISTORY|IMPORTXML|IMPORTDATA|IMPORTHTML|IMPORTRANGE)\s*\(", re.I)

class OfficeError(ValueError):
    pass

def _coordinate(cell):
    if not isinstance(cell, str) or not CELL.fullmatch(cell.upper()):
        raise OfficeError("Office workbook has an invalid cell coordinate")
    row, column = coordinate_to_tuple(cell)
    if row > 1048576 or column > 16384:
        raise OfficeError("Office cell lies outside the XLSX grid")
    return row, column

def _contains_controls(text):
    return any(ord(c) < 32 and c not in "\t\n\r" or 0xD800 <= ord(c) <= 0xDFFF for c in text)

def _xml(data):
    if b"\x00" in data or re.search(br"<!\s*(DOCTYPE|ENTITY)\b", data, re.I):
        raise OfficeError("Office XML with DTD/entities or non-UTF-8 encoding is unsupported")
    try:
        return ET.fromstring(data, parser=ET.XMLParser(resolve_entities=False, no_network=True, load_dtd=False))
    except ET.XMLSyntaxError as exc:
        raise OfficeError("Office file contains malformed XML") from exc

def _guard_formula(text):
    # Formula strings are literals, even if they contain names of network
    # functions. XML comments/tails must not split executable identifiers.
    formula = re.sub(r'"(?:[^"]|"")*"', '""', text)
    if "|" in formula or re.search(r"\[[^\]]+\][^+\-*/(),<>=;]*!|'(?:[^']|'')*\[[^\]]+\](?:[^']|'')*'!", formula) or UNSAFE_FORMULA_FUNCTION.search(formula):
        raise OfficeError("External, DDE or network/XLM-dependent workbook formulas are unsupported")

def _guard_formula_nodes(root, part_name):
    for node in root.iter():
        if not isinstance(node.tag, str): continue
        tag = ET.QName(node)
        namespace = tag.namespace or ""
        local = tag.localname.lower()
        spreadsheet = part_name.startswith("xl/") or "spreadsheetml" in namespace or namespace.startswith("http://schemas.microsoft.com/office/excel/") or namespace == "urn:schemas-microsoft-com:office:excel"
        chart = "drawingml" in namespace and namespace.endswith("/chart") or namespace.startswith("http://schemas.microsoft.com/office/drawing/") and "chart" in namespace
        if not (spreadsheet or chart): continue
        if local in FORMULA_TAGS or local.endswith("formula"):
            _guard_formula("".join(node.itertext()))
        if local == "definedname":
            name = node.get("name", "").casefold().rsplit(".", 1)[-1]
            if name in AUTO_MACRO_NAMES or any(node.get(flag, "0").casefold() not in ("0", "false") for flag in ("xlm", "function", "vbProcedure")):
                raise OfficeError("Auto-executing or XLM/macro defined names are unsupported")
        for key, value in node.attrib.items():
            attribute = ET.QName(key).localname.lower()
            if attribute in FORMULA_TAGS - {"definedname"} or attribute.endswith("formula") or attribute in ("refersto", "referstor1c1"):
                _guard_formula(value)

def _guard_word_instruction(instruction):
    if re.search(r"\b(?:DDE|DDEAUTO|INCLUDETEXT|INCLUDEPICTURE|LINK|DATABASE|RD)\b", instruction, re.I):
        raise OfficeError("External or DDE Word fields are unsupported")

def _guard_word_fields(root):
    # Word field code is a sequence of runs, not an instrText node. A stack
    # distinguishes instructions from displayed results and validates field
    # boundaries spanning multiple paragraphs. Nested dynamic fields are
    # refused: their runtime results could assemble an external instruction.
    fields = []
    for node in root.iter():
        if node.tag == f"{{{W}}}fldSimple":
            if fields or any(parent.tag == f"{{{W}}}fldSimple" for parent in node.iterancestors()):
                raise OfficeError("Nested Word fields are unsupported; use plain text instead")
            _guard_word_instruction(node.get(f"{{{W}}}instr", ""))
        elif node.tag == f"{{{W}}}fldChar":
            marker = node.get(f"{{{W}}}fldCharType", "")
            if marker == "begin":
                if fields or any(parent.tag == f"{{{W}}}fldSimple" for parent in node.iterancestors()):
                    raise OfficeError("Nested Word fields are unsupported; use plain text instead")
                fields.append({"instruction": [], "result": False})
            elif marker == "separate" and fields and not fields[-1]["result"]:
                fields[-1]["result"] = True
            elif marker == "end" and fields:
                _guard_word_instruction("".join(fields.pop()["instruction"]))
            else:
                raise OfficeError("Malformed Word fields are unsupported; use plain text instead")
        elif node.tag in (f"{{{W}}}instrText", f"{{{W}}}delInstrText"):
            if not fields or fields[-1]["result"]:
                raise OfficeError("Unbound or malformed Word fields are unsupported; use plain text instead")
            fields[-1]["instruction"].append("".join(node.itertext()))
    if fields:
        raise OfficeError("Unclosed Word fields are unsupported; use plain text instead")

def _package(raw, format, _budget=None):
    if format not in ("xlsx", "docx", "pptx") or not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_INPUT_BYTES:
        raise OfficeError("Office input must be DOCX/XLSX/PPTX, at most 10 MiB")
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
        infos = archive.infolist()
        if not 1 <= len(infos) <= 1000 or sum(i.file_size for i in infos) > MAX_EXPANDED_BYTES:
            raise OfficeError("Office ZIP exceeds 1000 parts / 30 MiB expanded content")
        budget = _budget if _budget is not None else {"expanded": 0}
        seen, parts = set(), {}
        for info in infos:
            name = info.filename
            if name.casefold() in seen or not name or name.startswith("/") or "\\" in name or any(ord(c) < 32 for c in name) or any(p in (".", "..", "") for p in name.rstrip("/").split("/")):
                raise OfficeError("Office ZIP has duplicate or unsafe part paths")
            seen.add(name.casefold())
            if info.flag_bits & 1 or info.file_size > MAX_PART_BYTES or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) or (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise OfficeError("Office ZIP has encrypted, linked, unsupported or oversized parts")
            if info.is_dir(): continue
            budget["expanded"] += info.file_size
            if budget["expanded"] > MAX_EXPANDED_BYTES:
                raise OfficeError("Office ZIP and chart data exceed 30 MiB expanded content")
            if info.file_size > max(4096, info.compress_size * 200):
                raise OfficeError("Office ZIP expansion ratio is excessive")
            lowered = name.lower()
            if any(token in lowered for token in ("vbaproject", "activex", "externallinks/", "macrosheets/", "xl/connections.xml", "xl/querytables/")):
                raise OfficeError("Macros, embedded objects and external workbook links are unsupported")
            parts[name] = archive.read(info)
        archive.close()
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
        raise OfficeError("Input is not a supported Office ZIP") from exc
    main = {"xlsx": "xl/workbook.xml", "docx": "word/document.xml", "pptx": "ppt/presentation.xml"}[format]
    if main not in parts or "[Content_Types].xml" not in parts:
        raise OfficeError("Office file does not match its declared extension")
    # Validate every XML and relationship before inspection or mutation. This
    # also catches dangerous unused parts rather than inspecting only the body.
    embedded_chart_data = set()
    for name, data in parts.items():
        if name.lower().endswith(".svg"):
            root = _xml(data)
            for node in root.iter():
                if ET.QName(node).localname.lower() in ("script", "foreignobject"):
                    raise OfficeError("Active SVG Office assets are unsupported")
                for key, value in node.attrib.items():
                    attr = ET.QName(key).localname.lower()
                    if attr.startswith("on") or attr == "href" and not value.startswith("#"):
                        raise OfficeError("External or active SVG Office assets are unsupported")
                css = (node.text or "") if ET.QName(node).localname.lower() == "style" else node.get("style", "")
                if "@import" in css.lower() or any(not match.group(1).strip(" \t\r\n\"'").startswith("#") for match in re.finditer(r"url\((.*?)\)", css, re.I | re.S)):
                    raise OfficeError("External SVG styles are unsupported")
        if name.lower().endswith((".xml", ".rels")):
            root = _xml(data)
            # Revisions request recalculation on open. Do not preserve an
            # unlinked network/DDE formula or Word include/link field whose
            # behavior is hidden inside XML instead of a .rels file.
            _guard_formula_nodes(root, name)
            _guard_word_fields(root)
            if name == "[Content_Types].xml":
                types = " ".join(node.get("ContentType", "") for node in root).lower()
                if any(token in types for token in ("macroenabled", "macrosheet", "vba", "activex", "oleobject", "connections", "querytable", "externallink")):
                    raise OfficeError("Active Office content is unsupported")
                expected = {"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"}[format]
                if not any(node.get("PartName") == "/" + main and node.get("ContentType") == expected for node in root):
                    raise OfficeError("Office content type does not match its declared extension")
            if name.endswith(".rels"):
                ids = set()
                for relationship in root:
                    id = relationship.get("Id")
                    target = relationship.get("Target", "")
                    if not id or id in ids or not target:
                        raise OfficeError("Office file has missing or duplicate relationship identifiers")
                    ids.add(id)
                    if relationship.get("TargetMode", "").lower() not in ("", "internal") or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target) or "\\" in target or "%" in target or target.startswith("//"):
                        raise OfficeError("Office files with external relationships are unsupported")
                    # OOXML relationship targets resolve relative to the source
                    # part, not relative to the _rels directory itself.
                    base = posixpath.dirname(posixpath.dirname(name)) if "/_rels/" in name else ""
                    resolved = posixpath.normpath(posixpath.join(base, target.lstrip("/"))) if not target.startswith("/") else target[1:]
                    if resolved.startswith("../") or (resolved.split("#", 1)[0] not in parts):
                        raise OfficeError("Office file has a missing or unsafe relationship target")
                    if relationship.get("Type", "").lower().endswith(("/oleobject", "/control", "/attachedtemplate", "/afchunk", "/connections", "/querytable", "/externallink", "/externallinkpath")):
                        raise OfficeError("Embedded or active Office objects are unsupported")
                    if format == "pptx" and re.fullmatch(r"ppt/charts/_rels/chart[0-9]+\.xml\.rels", name) and relationship.get("Type") == OR + "/package" and resolved.lower().endswith(".xlsx"):
                        embedded_chart_data.add(resolved)
    for name, data in parts.items():
        if "/embeddings/" in name.lower():
            # Native PowerPoint charts contain an ordinary XLSX data package,
            # not an executable OLE object. Preserve it only when an actual
            # chart relationship names it and it passes the same strict guard.
            if name not in embedded_chart_data:
                raise OfficeError("Embedded Office objects are unsupported")
            _package(data, "xlsx", budget)
    return parts

def _relationships(parts, part):
    relname = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    if relname not in parts: return {}
    base = posixpath.dirname(part)
    return {r.get("Id"): posixpath.normpath(posixpath.join(base, r.get("Target", ""))) if not r.get("Target", "").startswith("/") else r.get("Target")[1:] for r in _xml(parts[relname])}

def _sheets(parts):
    root = _xml(parts["xl/workbook.xml"])
    relations = _relationships(parts, "xl/workbook.xml")
    sheets = [(sheet.get("name"), relations.get(sheet.get(f"{{{OR}}}id"))) for sheet in root.findall(f"{{{S}}}sheets/{{{S}}}sheet")]
    if not sheets or len(sheets) > 1000 or len({name for name, _part in sheets}) != len(sheets) or any(not isinstance(name, str) or not 1 <= len(name) <= 31 or part not in parts for name, part in sheets):
        raise OfficeError("Workbook has invalid sheet names or relationships")
    return sheets

def _strings(parts):
    if "xl/sharedStrings.xml" not in parts: return []
    return ["".join((t.text or "") for t in n.findall(f"{{{S}}}t") + n.findall(f"{{{S}}}r/{{{S}}}t")) for n in _xml(parts["xl/sharedStrings.xml"]).findall(f"{{{S}}}si")]

def _cell_value(cell, strings):
    kind = cell.get("t")
    value = cell.find(f"{{{S}}}v")
    text = value.text if value is not None else None
    if kind == "inlineStr":
        inline = cell.find(f"{{{S}}}is")
        return "".join((t.text or "") for t in inline.findall(f"{{{S}}}t") + inline.findall(f"{{{S}}}r/{{{S}}}t")) if inline is not None else ""
    if kind == "s":
        try: return strings[int(text)]
        except (ValueError, TypeError, IndexError): raise OfficeError("Office workbook has an invalid shared string")
    if kind == "b": return text == "1"
    if kind in ("str", "e", "d"): return text
    if text is None: return None
    try:
        number = float(text)
        if not math.isfinite(number): raise ValueError()
        return int(number) if number.is_integer() else number
    except ValueError: raise OfficeError("Office workbook has an invalid numeric cell")

def _paragraphs(parts, format):
    if format == "docx": names = ["word/document.xml"]
    else:
        relations = _relationships(parts, "ppt/presentation.xml")
        names = [relations.get(slide.get(f"{{{OR}}}id")) for slide in _xml(parts["ppt/presentation.xml"]).findall(f"{{{P}}}sldIdLst/{{{P}}}sldId")]
        if any(name not in parts or not re.fullmatch(r"ppt/slides/slide[0-9]+\.xml", name) for name in names) or len(set(names)) != len(names):
            raise OfficeError("Presentation has invalid slide relationships")
    # Word header/footer and PowerPoint notes are inspectable/revisable too.
    names.extend(sorted(name for name in parts if re.fullmatch(r"word/(header|footer)[0-9]+\.xml", name))) if format == "docx" else names.extend(sorted(name for name in parts if re.fullmatch(r"ppt/notesSlides/notesSlide[0-9]+\.xml", name)))
    namespace = W if format == "docx" else A
    for name in names:
        root = _xml(parts[name])
        for index, paragraph in enumerate(root.iter(f"{{{namespace}}}p")):
            # Explicit tabs/breaks matter for faithful inspection.
            text = "".join((node.text or "") if node.tag == f"{{{namespace}}}t" else "\t" if node.tag == f"{{{namespace}}}tab" else "\n" if node.tag in (f"{{{namespace}}}br", f"{{{namespace}}}cr") else "" for node in paragraph.iter())
            yield name, root, paragraph, f"{name}:p:{index}", text

def inspect_office(raw, format):
    parts = _package(raw, format)
    count, chars, items = 0, 0, []
    if format == "xlsx":
        strings, sheets = _strings(parts), []
        for name, part in _sheets(parts):
            if part not in parts: raise OfficeError("Workbook sheet relationship is unavailable")
            root = _xml(parts[part]); cells = []
            actual_count = 0
            for cell in root.findall(f"{{{S}}}sheetData/{{{S}}}row/{{{S}}}c"):
                actual_count += 1; count += 1
                _coordinate(cell.get("r"))
                if len(items) >= MAX_ITEMS or chars >= MAX_TEXT: continue
                value = _cell_value(cell, strings)
                if isinstance(value, str) and len(value) > 4000: value = value[:4000]; clipped = True
                else: clipped = False
                formula = cell.find(f"{{{S}}}f")
                entry = {"sheet": name, "cell": cell.get("r"), "value": value}
                if formula is not None:
                    formula_text = formula.text or ""
                    entry["formula"] = formula_text[:4000]; entry["formulaKind"] = formula.get("t", "normal")
                    if len(formula_text) > 4000: entry["formulaTruncated"] = True
                if clipped: entry["valueTruncated"] = True
                chars += len(str(value or "")) + len(entry.get("formula", "")); items.append(entry); cells.append(entry)
            sheets.append({"name": name, "cellCount": actual_count, "cells": cells})
        return {"format": format, "sheets": sheets, "totalItems": count, "returnedItems": len(items), "truncated": count > len(items), "warnings": ["Formula values are saved caches; inspection does not recalculate them."]}
    for _name, _root, _paragraph, id, text in _paragraphs(parts, format):
        count += 1
        if len(items) >= MAX_ITEMS or chars >= MAX_TEXT: continue
        items.append({"id": id, "part": _name, "text": text[:4000], **({"textTruncated": True} if len(text) > 4000 else {})}); chars += min(len(text), 4000)
    return {"format": format, "paragraphs": items, "totalItems": count, "returnedItems": len(items), "truncated": count > len(items), "warnings": []}

def revise_office(raw, format, changes):
    parts = _package(raw, format)
    if not isinstance(changes, dict) or set(changes) - {"cells", "text"}: raise OfficeError("changes must contain cells or text operations")
    operations = changes.get("cells" if format == "xlsx" else "text", [])
    if changes.get("text" if format == "xlsx" else "cells"): raise OfficeError("Revision operations do not match the Office format")
    if not isinstance(operations, list) or not 1 <= len(operations) <= 200: raise OfficeError("Office revision needs 1-200 operations")
    changed, seen = {}, set()
    if format == "xlsx":
        sheets = dict(_sheets(parts))
        for operation in operations:
            if not isinstance(operation, dict) or set(operation) != {"sheet", "cell", "value"}: raise OfficeError("Each cell operation needs sheet, cell and value")
            sheet, cell, value = operation["sheet"], operation["cell"], operation["value"]
            if not isinstance(sheet, str) or sheet not in sheets or not isinstance(cell, str) or not CELL.fullmatch(cell.upper()): raise OfficeError("Cell operation needs an existing sheet and A1 cell")
            cell = cell.upper(); key = sheet, cell
            row, column = _coordinate(cell)
            if key in seen: raise OfficeError("Duplicate revision target")
            seen.add(key)
            if value is not None and not isinstance(value, (str, bool, int, float)): raise OfficeError("Cell value must be a JSON scalar")
            if isinstance(value, str) and (len(value) > 32767 or _contains_controls(value)): raise OfficeError("Cell string exceeds Office limits or contains controls")
            if isinstance(value, (float, int)) and (isinstance(value, float) and not math.isfinite(value) or abs(value) > 1e308): raise OfficeError("Cell number must be finite")
            part = sheets[sheet]; root = changed.setdefault(part, _xml(parts[part]))
            target = next((node for node in root.findall(f"{{{S}}}sheetData/{{{S}}}row/{{{S}}}c") if node.get("r", "").upper() == cell), None)
            # Refuse grid expansion/merge ambiguity. Inspection IDs identify
            # existing serialized cells, including blanks with native styling.
            if target is None: raise OfficeError("Revision target must be an existing serialized cell; inspect first")
            for merged in root.findall(f"{{{S}}}mergeCells/{{{S}}}mergeCell"):
                bounds = range_boundaries(merged.get("ref"))
                if bounds[0] <= column <= bounds[2] and bounds[1] <= row <= bounds[3] and (row, column) != (bounds[1], bounds[0]): raise OfficeError("Revise the top-left cell of a merged range")
            for grouped in root.findall(f"{{{S}}}sheetData/{{{S}}}row/{{{S}}}c/{{{S}}}f"):
                if grouped.get("t") in ("array", "shared", "dataTable") and grouped.get("ref"):
                    bounds = range_boundaries(grouped.get("ref"))
                    if bounds[0] <= column <= bounds[2] and bounds[1] <= row <= bounds[3]:
                        raise OfficeError("Replacing cells within shared, array or data-table formula ranges is unsupported")
            formula = target.find(f"{{{S}}}f")
            if formula is not None and formula.get("t") in ("array", "shared", "dataTable"): raise OfficeError("Replacing shared, array or data-table formulas is unsupported")
            for child in list(target):
                if child.tag in (f"{{{S}}}f", f"{{{S}}}v", f"{{{S}}}is"): target.remove(child)
            if isinstance(value, str):
                # Inline string is inert even if it begins with =/+/−/@.
                target.set("t", "inlineStr"); text = ET.SubElement(ET.SubElement(target, f"{{{S}}}is"), f"{{{S}}}t"); text.text = value; text.set(XML_SPACE, "preserve")
            elif value is None: target.attrib.pop("t", None)
            else:
                target.set("t", "b" if isinstance(value, bool) else "n"); ET.SubElement(target, f"{{{S}}}v").text = str(int(value)) if isinstance(value, bool) else str(value)
        # Cell changes can invalidate any transitive formula or native chart.
        # Keep formulas intact, remove stale caches and request Excel recalc.
        for _sheet, part in _sheets(parts):
            root = changed.get(part)
            if root is None: root = _xml(parts[part])
            for cell in root.findall(f"{{{S}}}sheetData/{{{S}}}row/{{{S}}}c"):
                if cell.find(f"{{{S}}}f") is not None:
                    for cached in cell.findall(f"{{{S}}}v"):
                        cell.remove(cached); changed[part] = root
        for name in parts:
            if re.fullmatch(r"xl/charts/chart[0-9]+\.xml", name):
                root = _xml(parts[name])
                for node in root.xpath("//*[local-name()='numCache' or local-name()='strCache']"):
                    node.getparent().remove(node); changed[name] = root
        root = changed.setdefault("xl/workbook.xml", _xml(parts["xl/workbook.xml"]))
        calculation = root.find(f"{{{S}}}calcPr")
        if calculation is None: calculation = ET.SubElement(root, f"{{{S}}}calcPr")
        calculation.set("fullCalcOnLoad", "1"); calculation.set("forceFullCalc", "1"); calculation.set("calcMode", "auto")
    else:
        paragraphs = {id: (name, root, paragraph) for name, root, paragraph, id, _text in _paragraphs(parts, format)}
        # _paragraphs produces each part tree once per call; all entries from a
        # part share that same root, so multiple edits preserve one another.
        namespace = W if format == "docx" else A
        for operation in operations:
            if not isinstance(operation, dict) or set(operation) != {"id", "text"}: raise OfficeError("Each text operation needs an inspected id and replacement text")
            id, text = operation["id"], operation["text"]
            if not isinstance(id, str) or id not in paragraphs or id in seen: raise OfficeError("Missing or duplicate paragraph revision target; inspect first")
            seen.add(id)
            if not isinstance(text, str) or len(text) > 4000 or _contains_controls(text): raise OfficeError("Replacement paragraph must be bounded text without controls")
            name, root, paragraph = paragraphs[id]
            if any(ET.QName(node).localname in ("fldChar", "instrText", "fldSimple", "drawing", "object", "pict", "sdt", "fld") for node in paragraph.iter()) or any(ET.QName(node).localname == "sdt" for node in paragraph.iterancestors()): raise OfficeError("Paragraphs containing fields, images, objects or content controls cannot be replaced")
            changed[name] = root
            texts = list(paragraph.iter(f"{{{namespace}}}t"))
            if not texts:
                run = ET.Element(f"{{{namespace}}}r")
                end_properties = paragraph.find(f"{{{namespace}}}endParaRPr")
                if end_properties is not None: paragraph.insert(list(paragraph).index(end_properties), run)
                else: paragraph.append(run)
                texts = [ET.SubElement(run, f"{{{namespace}}}t")]
            texts[0].text = text; texts[0].set(XML_SPACE, "preserve")
            for node in texts[1:]: node.text = ""
            for node in list(paragraph.iter()):
                if node.tag in (f"{{{namespace}}}tab", f"{{{namespace}}}br", f"{{{namespace}}}cr"): node.getparent().remove(node)
    for name, root in changed.items(): parts[name] = ET.tostring(root, encoding="UTF-8", xml_declaration=True, standalone=True)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in parts.items(): archive.writestr(name, data)
    result = buffer.getvalue()
    if len(result) > MAX_INPUT_BYTES: raise OfficeError("Revised Office file exceeds 10 MiB")
    return result
