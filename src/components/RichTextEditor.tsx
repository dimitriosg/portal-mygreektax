import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  List,
  ListOrdered,
  Link as LinkIcon,
  Unlink,
} from "lucide-react";

// Rich text editor used by the review desk. TipTap v3, React 19 compatible.
// It emits HTML via onChange. It is initialised once from `initialHtml`;
// after that the parent should remount it (via key) to load new content,
// so it never clobbers the operator's in-progress edits.

const SWATCHES = [
  { label: "Default", value: "#1E2A3A" },
  { label: "Amber", value: "#C9923A" },
  { label: "Sage", value: "#6B8F71" },
  { label: "Red", value: "#B4443C" },
  { label: "Grey", value: "#6b7280" },
];

interface RichTextEditorProps {
  initialHtml: string;
  onChange: (html: string) => void;
}

export function RichTextEditor({ initialHtml, onChange }: RichTextEditorProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Keep it email-appropriate: no headings, no code blocks, no images.
        heading: false,
        codeBlock: false,
        horizontalRule: false,
        blockquote: false,
      }),
      Underline,
      TextStyle,
      Color,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          rel: "noopener noreferrer nofollow",
          target: "_blank",
        },
      }),
    ],
    content: initialHtml,
    editorProps: {
      attributes: {
        class:
          "min-h-[280px] w-full rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 prose prose-sm max-w-none",
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
  });

  // Emit once on mount so the parent has the initial HTML even before edits.
  useEffect(() => {
    if (editor) onChange(editor.getHTML());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  if (!editor) {
    return (
      <div className="min-h-[280px] rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-400">
        Loading editor...
      </div>
    );
  }

  const applyLink = () => {
    const url = linkUrl.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    setLinkOpen(false);
    setLinkUrl("");
  };

  const btn = (active: boolean) =>
    `h-8 w-8 p-0 ${active ? "bg-slate-200 text-slate-900" : "text-slate-600"}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1 border border-slate-200 rounded-md p-1 bg-slate-50">
        <Button
          type="button"
          variant="ghost"
          className={btn(editor.isActive("bold"))}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Bold"
        >
          <Bold className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={btn(editor.isActive("italic"))}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italic"
        >
          <Italic className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={btn(editor.isActive("underline"))}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          title="Underline"
        >
          <UnderlineIcon className="h-4 w-4" />
        </Button>

        <span className="w-px h-5 bg-slate-300 mx-1" />

        <Button
          type="button"
          variant="ghost"
          className={btn(editor.isActive("bulletList"))}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Bullet list"
        >
          <List className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={btn(editor.isActive("orderedList"))}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="Numbered list"
        >
          <ListOrdered className="h-4 w-4" />
        </Button>

        <span className="w-px h-5 bg-slate-300 mx-1" />

        <Button
          type="button"
          variant="ghost"
          className={btn(editor.isActive("link"))}
          onClick={() => {
            const prev = editor.getAttributes("link").href as string | undefined;
            setLinkUrl(prev ?? "");
            setLinkOpen((v) => !v);
          }}
          title="Add or edit link"
        >
          <LinkIcon className="h-4 w-4" />
        </Button>
        {editor.isActive("link") && (
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-8 p-0 text-slate-600"
            onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}
            title="Remove link"
          >
            <Unlink className="h-4 w-4" />
          </Button>
        )}

        <span className="w-px h-5 bg-slate-300 mx-1" />

        <div className="flex items-center gap-1">
          {SWATCHES.map((s) => (
            <button
              key={s.value}
              type="button"
              title={s.label}
              onClick={() => editor.chain().focus().setColor(s.value).run()}
              className="h-5 w-5 rounded-full border border-slate-300"
              style={{ backgroundColor: s.value }}
            />
          ))}
          <button
            type="button"
            title="Clear colour"
            onClick={() => editor.chain().focus().unsetColor().run()}
            className="h-5 px-2 text-xs text-slate-500 hover:text-slate-800"
          >
            reset
          </button>
        </div>
      </div>

      {linkOpen && (
        <div className="flex items-center gap-2 border border-slate-200 rounded-md p-2 bg-white">
          <input
            type="url"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              }
            }}
            placeholder="https://example.com"
            className="flex-1 text-sm border border-slate-200 rounded px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          />
          <Button type="button" onClick={applyLink} className="h-8 px-3 text-xs">
            Apply
          </Button>
        </div>
      )}

      <EditorContent editor={editor} />
    </div>
  );
}
