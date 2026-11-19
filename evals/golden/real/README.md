# Real invoices (not yet added)

Synthetic documents are clean in ways real ones are not: real suppliers mis-total, print
"Total due" twice, staple a remittance slip to page 2 and scan at an angle. The plan is 50 real
invoices here, with hand labels.

How to add one:

1. Redact before it enters the repo: supplier bank details, personal names, signatures, and any
   address that identifies a person. Keep amounts, dates and layout intact; that is what is tested.
2. Save the PDF as `real-NNN.pdf` and write `real-NNN.json` in the same shape as the synthetic
   files (`labels`, `expected`, `context`, `tags` with `"source": "real"`).
3. Label from the document, not from the ERP: the eval measures reading, and the ERP may hold a
   corrected value.
4. Have a second person check each label file. A wrong label costs more than a missing document.

The harness runs with zero files here.
