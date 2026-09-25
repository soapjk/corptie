// Shared presentation syntax only. The model chooses whether visualization
// helps; the client validates and renders inert data inside its message card.
export const CHART_PRESENTATION_INSTRUCTIONS = [
  "When a chart would materially clarify numerical data in your reply, you may place a fenced ```corptie-chart block inline with the surrounding prose. This is optional; do not add charts by default or invent data.",
  "The fence contains one JSON object: {\"version\":1,\"type\":\"bar\",\"title\":\"Comparison\",\"unit\":\"hours\",\"data\":[{\"label\":\"A\",\"value\":2}]}. Supported types: bar and pie use {label,value} with unique category labels; line uses {x,value} with ascending numeric x, YYYY-MM-DD dates, or full ISO-8601 timestamps with timezone. Pie values must be positive and represent parts of one whole.",
  "Limits: at most 4 charts per reply, 100 points per bar/line chart, 7 pie slices and 32 KiB per fence. Use sourceNote only to describe a source you actually have; it is not a verified citation. Keep the explanation in ordinary prose before or after the fence. Do not emit HTML, CSS, SVG, JavaScript, URLs or executable code inside the chart block."
].join(" ");
