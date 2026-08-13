import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import type { ReactNode } from "react";

interface OrderedItem {
  id: string;
}

export interface SortableRenderState {
  itemRef: (element: Element | null) => void;
  handleRef: (element: Element | null) => void;
  isDragging: boolean;
}

interface SortableListProps<T extends OrderedItem> {
  items: readonly T[];
  type: string;
  disabled?: boolean;
  onReorder: (from: number, to: number) => void;
  children: (item: T, index: number, state: SortableRenderState) => ReactNode;
}

interface SortableRegistrationProps<T extends OrderedItem> {
  item: T;
  index: number;
  type: string;
  disabled: boolean;
  render: SortableListProps<T>["children"];
}

function SortableRegistration<T extends OrderedItem>({
  item,
  index,
  type,
  disabled,
  render,
}: SortableRegistrationProps<T>) {
  const { ref, handleRef, isDragging } = useSortable({
    id: item.id,
    index,
    type,
    accept: type,
    group: type,
    disabled,
  });
  return render(item, index, { itemRef: ref, handleRef, isDragging });
}

export function SortableList<T extends OrderedItem>({
  items,
  type,
  disabled = false,
  onReorder,
  children,
}: SortableListProps<T>) {
  return (
    <DragDropProvider
      onDragEnd={(event) => {
        if (event.canceled) return;
        const { source } = event.operation;
        if (isSortable(source) && source.initialIndex !== source.index)
          onReorder(source.initialIndex, source.index);
      }}
    >
      {items.map((item, index) => (
        <SortableRegistration
          key={item.id}
          item={item}
          index={index}
          type={type}
          disabled={disabled}
          render={children}
        />
      ))}
    </DragDropProvider>
  );
}
