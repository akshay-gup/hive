import { type RefObject, useEffect, useRef } from "react";
import { colors } from "./ui";

const KIND = "application/x-hive-task";

/** Make the element a card that can be picked up and dropped on a column (`id` null: it cannot). */
export function useDragSource(ref: RefObject<unknown>, id: string | null) {
  useEffect(() => {
    const node = ref.current as HTMLElement | null;
    if (!node || !id || typeof node.addEventListener !== "function") return;
    node.draggable = true;
    const start = (event: DragEvent) => {
      event.dataTransfer?.setData(KIND, id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      node.style.opacity = "0.5";
    };
    const end = () => {
      node.style.opacity = "";
    };
    node.addEventListener("dragstart", start);
    node.addEventListener("dragend", end);
    return () => {
      node.draggable = false;
      node.style.opacity = "";
      node.removeEventListener("dragstart", start);
      node.removeEventListener("dragend", end);
    };
  }, [ref, id]);
}

/** Make the element take a card dropped on it, and show that it will. */
export function useDropTarget(ref: RefObject<unknown>, onDrop: (id: string) => void) {
  const latest = useRef(onDrop);
  latest.current = onDrop;
  useEffect(() => {
    const node = ref.current as HTMLElement | null;
    if (!node || typeof node.addEventListener !== "function") return;
    const carries = (event: DragEvent) => !!event.dataTransfer?.types.includes(KIND);
    const light = (on: boolean) => {
      node.style.backgroundColor = on ? colors.surface : "";
    };
    const over = (event: DragEvent) => {
      if (!carries(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      light(true);
    };
    const leave = (event: DragEvent) => {
      // Moving over a card inside the column is not leaving it.
      if (!node.contains(event.relatedTarget as Node | null)) light(false);
    };
    const drop = (event: DragEvent) => {
      if (!carries(event)) return;
      event.preventDefault();
      light(false);
      const id = event.dataTransfer?.getData(KIND);
      if (id) latest.current(id);
    };
    node.addEventListener("dragover", over);
    node.addEventListener("dragleave", leave);
    node.addEventListener("drop", drop);
    return () => {
      light(false);
      node.removeEventListener("dragover", over);
      node.removeEventListener("dragleave", leave);
      node.removeEventListener("drop", drop);
    };
  }, [ref]);
}
