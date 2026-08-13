interface OrderedItem {
  id: string;
}

export function parseStoredOrder(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (id, index, values): id is string => typeof id === "string" && values.indexOf(id) === index,
    );
  } catch {
    return [];
  }
}

export function applyStoredOrder<T extends OrderedItem>(items: readonly T[], order: string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = order.flatMap((id) => {
    const item = byId.get(id);
    if (!item) return [];
    byId.delete(id);
    return [item];
  });
  return [...ordered, ...byId.values()];
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const moved = [...items];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item!);
  return moved;
}
