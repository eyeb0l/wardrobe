const categories = ['upperbody', 'dresses', 'wholebody_up', 'lowerbody', 'accessories_up', 'shoes'];

// Saved positions belong to a category. Apply this after resolving all metadata
// overrides so unchanged categories retain their order across every writer.
export function resetOrderOnCategoryChange(previous, next) {
  if (!previous || previous.part === next.part) return next;
  const { sortOrder, ...record } = next;
  return record;
}

export function compareWardrobeItems(a, b) {
  const category = part => categories.includes(part) ? categories.indexOf(part) : categories.length;
  const group = category(a.part) - category(b.part) || (a.part === b.part ? 0 : String(a.part).localeCompare(String(b.part)));
  if (group) return group;
  const rank = item => Number.isSafeInteger(item.sortOrder) && item.sortOrder >= 0 ? item.sortOrder : Number.MAX_SAFE_INTEGER;
  return rank(a) - rank(b) || a.id.localeCompare(b.id);
}

export function moveWithinCategory(items, id, targetId) {
  const item = items.find(item => item.id === id);
  const target = items.find(item => item.id === targetId);
  if (!item || !target || item.part !== target.part || id === targetId) return null;
  const expectedIds = items.filter(value => value.part === item.part).sort(compareWardrobeItems).map(value => value.id);
  const ids = [...expectedIds];
  const destination = ids.indexOf(targetId);
  ids.splice(ids.indexOf(id), 1);
  ids.splice(destination, 0, id);
  return { part: item.part, ids, expectedIds };
}
