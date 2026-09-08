/** Raw-graph topology for semantic HTML; visible Original items never come from it. */
export function originalDisplayGroups(doc) {
  if (doc?.canonicalOriginalTree) {
    return (doc.canonicalOriginalTree.paragraphs || []).map(p=>({
      id:String(p.id), paragraphIds:(p.source?.documentParagraphIds || []).map(String),
      text:String(p.text || ''), direction:p.direction,
    })).filter(g=>g.paragraphIds.length);
  }
  return doc?.groups || [];
}
