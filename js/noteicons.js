// Sticky-note icon appearances (24x24 user units), used on the page overlay and in the inspector.
export function noteIconSvg(name, color = '#ffe100') {
  const bg = `<path d="M3 2h18v14l-5 5H3z" fill="${color}" stroke="#444" stroke-width="1.2"/><path d="M16 21v-5h5" fill="none" stroke="#444" stroke-width="1.2"/>`;
  const glyphs = {
    Comment: '<path d="M6 7h10M6 10h8M6 13h5" stroke="#333" stroke-width="1.5" fill="none"/>',
    Note: '<path d="M6 7h10M6 10h10M6 13h6" stroke="#333" stroke-width="1.5" fill="none"/>',
    Key: '<circle cx="8" cy="10" r="3" fill="none" stroke="#333" stroke-width="1.5"/><path d="M11 10h7M16 10v3M14 10v2" stroke="#333" stroke-width="1.5"/>',
    Help: '<path d="M9 8a3 3 0 1 1 4 2.8c-.7.4-1 1-1 1.7M12 15v.5" stroke="#333" stroke-width="1.6" fill="none"/>',
    NewParagraph: '<path d="M8 15V6l5 9V6" stroke="#333" stroke-width="1.6" fill="none"/>',
    Paragraph: '<path d="M14 5v11M11 5v11M14 5h-3a3 3 0 0 0 0 6h3" stroke="#333" stroke-width="1.5" fill="none"/>',
    Insert: '<path d="M6 15l6-9 6 9z" fill="#333"/>',
    Check: '<path d="M6 11l4 4 8-8" stroke="#2a2" stroke-width="2.2" fill="none"/>',
    Circle: '<circle cx="12" cy="11" r="5" stroke="#333" stroke-width="1.8" fill="none"/>',
    Cross: '<path d="M7 6l10 10M17 6L7 16" stroke="#c22" stroke-width="2"/>',
    RightArrow: '<path d="M5 11h12M12 6l5 5-5 5" stroke="#333" stroke-width="2" fill="none"/>',
    RightPointer: '<path d="M6 6l12 5-12 5z" fill="#333"/>',
    Star: '<path d="M12 4l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 9.3l5-.7z" fill="#e8b400" stroke="#333" stroke-width="1"/>',
    UpArrow: '<path d="M12 17V5M7 10l5-5 5 5" stroke="#333" stroke-width="2" fill="none"/>',
    UpLeftArrow: '<path d="M17 16L7 6M7 13V6h7" stroke="#333" stroke-width="2" fill="none"/>',
  };
  return bg + (glyphs[name] || glyphs.Note);
}
