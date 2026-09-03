import {
  Button,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from '../../components';
import type { TreeNode as FileTreeNode } from '../../lib/types';
import { Highlight, matchPath } from '../search';

/**
 * One row, and its children.
 *
 * Plainly recursive, because the server hands over a tree that is already
 * nested and already sorted. The only state involved is "is this folder open",
 * and that lives in one Set held by the page — not per node, so it survives
 * every refetch.
 */
export interface TreeNodeHandlers {
  expanded: Set<string>;
  selectedId: string | null;
  canEdit: boolean;
  /** The sidebar filter, so a matched row can show WHY it matched. Empty when
   *  no filter is active, and then nothing is highlighted. */
  highlight: string;
  onToggle: (path: string) => void;
  onSelect: (node: FileTreeNode) => void;
  onNew: (parentPath: string) => void;
  onRename: (node: FileTreeNode) => void;
  onDelete: (node: FileTreeNode) => void;
}

export function TreeNode({
  node,
  depth,
  handlers,
}: {
  node: FileTreeNode;
  depth: number;
  handlers: TreeNodeHandlers;
}) {
  const { expanded, selectedId, canEdit, highlight, onToggle, onSelect, onNew, onRename, onDelete } =
    handlers;

  /**
   * Folders are tracked by PATH, not id. A path is unique per project and is
   * what "the folder I opened" actually means to the user; it also makes
   * expanding the ancestors of a freshly created file a string operation rather
   * than a lookup into a tree that has not arrived yet. The trade-off is that
   * renaming a folder collapses it, which is honest — it is a different path.
   *
   * Module 10.3 kept this keyed by path deliberately: switching to `node.id`
   * while adding icons would have silently broken ancestor-expansion.
   */
  const isOpen = expanded.has(node.path);
  const isSelected = node.id === selectedId;

  // Over the NAME, not the path: that is the string this row draws. A folder
  // kept only because a descendant matched has no match of its own, and
  // matchPath returning null is exactly the right answer for it.
  const match = highlight.length > 0 ? matchPath(node.name, highlight) : null;

  return (
    <li>
      <div
        className={[
          'group relative flex items-center gap-1 pr-1 transition-colors duration-100',
          // Only the SELECTED row gets the accent bar. Hover must never look
          // selected — that is the confusion --color-elevated-hover exists for.
          isSelected
            ? 'bg-elevated before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent'
            : 'hover:bg-elevated-hover',
        ].join(' ')}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <button
          type="button"
          onClick={() => (node.isDir ? onToggle(node.path) : onSelect(node))}
          title={node.path}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
        >
          <span aria-hidden="true" className="flex w-3 shrink-0 justify-center text-muted">
            {node.isDir ? (
              isOpen ? (
                <ChevronDownIcon className="h-3 w-3" />
              ) : (
                <ChevronRightIcon className="h-3 w-3" />
              )
            ) : null}
          </span>

          <span
            aria-hidden="true"
            className={`shrink-0 ${isSelected ? 'text-accent' : 'text-muted'}`}
          >
            {node.isDir ? (
              isOpen ? (
                <FolderOpenIcon className="h-3.5 w-3.5" />
              ) : (
                <FolderIcon className="h-3.5 w-3.5" />
              )
            ) : (
              <FileIcon className="h-3.5 w-3.5" />
            )}
          </span>

          <span className={`truncate text-xs ${isSelected ? 'text-ink' : 'text-muted'}`}>
            {match ? <Highlight text={node.name} ranges={match.ranges} /> : node.name}
          </span>
        </button>

        {/* Faded until the row is hovered or something inside it has focus, so
            the tree stays readable without taking the buttons out of the page.
            `hidden` would be display:none, which drops them from the tab order
            entirely — unreachable by keyboard, and invisible on touch devices
            that have no hover at all. Hidden outright for a VIEWER, whose
            writes the server would refuse anyway. */}
        {canEdit ? (
          <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100">
            {node.isDir ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onNew(node.path)}
                aria-label={`New file in ${node.path}`}
                title={`New file in ${node.path}`}
                className="h-6 px-1"
              >
                <PlusIcon className="h-3.5 w-3.5" />
              </Button>
            ) : null}

            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRename(node)}
              aria-label={`Rename or move ${node.path}`}
              title={`Rename or move ${node.path}`}
              className="h-6 px-1"
            >
              <PencilIcon className="h-3.5 w-3.5" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDelete(node)}
              aria-label={`Delete ${node.path}`}
              title={`Delete ${node.path}`}
              className="h-6 px-1 hover:text-danger"
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </Button>
          </span>
        ) : null}
      </div>

      {node.isDir && isOpen && node.children.length > 0 ? (
        <ul>
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} depth={depth + 1} handlers={handlers} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
