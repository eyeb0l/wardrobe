export const WORN_LOOK_PARTS = ['upperbody', 'lowerbody', 'dresses', 'wholebody_up', 'shoes', 'accessories_up'];

// Actual worn combinations can include dresses; automatic generation keeps
// its existing top-and-bottom constraints.
export function wornLookIssue(pieces) {
  if (pieces.some(piece => !piece || piece.hidden || piece.deleted)) return 'A selected piece is no longer available. Refresh your wardrobe and review the selection.';
  if (pieces.length > 5) return 'Choose at most five pieces for one look.';
  const counts = new Map(WORN_LOOK_PARTS.map(part => [part, pieces.filter(piece => piece.part === part).length]));
  if (pieces.some(piece => !WORN_LOOK_PARTS.includes(piece.part)) || [...counts.values()].some(count => count > 1)
    || !(counts.get('dresses') === 1 ? !counts.get('upperbody') && !counts.get('lowerbody') : counts.get('upperbody') === 1 && counts.get('lowerbody') === 1)) {
    return 'Choose one dress or one top and one bottom, with at most one jacket, pair of shoes and accessory.';
  }
  return '';
}

export function matchingSavedLook(outfits, ids) {
  if (!ids.length) return null;
  const key = [...ids].sort().join('|');
  return outfits.find(outfit => outfit.status === 'accepted' && outfit.image && outfit.garmentIds.length === ids.length
    && [...outfit.garmentIds].sort().join('|') === key) || null;
}
