from docx import Document

doc = Document("Not-Working-Text.docx")

found_nbsp = False

for para in doc.paragraphs:
    if "\u00A0" in para.text:
        found_nbsp = True
        print("NBSP found in paragraph:")
        print(repr(para.text))

if not found_nbsp:
    print("No NBSP found.")
