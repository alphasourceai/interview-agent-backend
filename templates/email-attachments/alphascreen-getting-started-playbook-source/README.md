# alphaScreen Getting Started playbook source

This directory contains the recovered canonical HTML, CSS, fonts, and images for
`../alphascreen-getting-started-playbook.pdf`.

Generate the PDF with WeasyPrint 69 from this directory:

```sh
weasyprint playbook.html ../alphascreen-getting-started-playbook.pdf
```

After regeneration, confirm the document remains 12 landscape Letter pages,
render every page to PNG for visual inspection, and record the old and new
SHA-256 hashes.
