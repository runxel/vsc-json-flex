# JSON Flex

Prettify and uglify JSON / JSONC, and browse or edit it in a fast tree view (Firefox's JSON viewer was the paragon). 
The tree view should stay responsive even with huge documents.

## Features

### Prettify
**JSON Flex: Prettify** reformats minified, one-line JSON so it becomes human readable again:

- Arrays and objects that contain only primitives stay on one line when they fit (`[123.56, 987.6]` instead of four lines).
- Comments are kept. A trailing comment stays on its line.
- Numbers and strings are copied exactly as written, so precision and escapes are preserved.
- Uses the editor's indentation (tabs or spaces, detected like VS Code does) and the file's line endings.

### Uglify
**JSON Flex: Uglify (Minify)** minifies the JSON back into one line. All whitespace, all comments and trailing commas are removed.

Both commands are in the editor title `…` menu and the editor context menu for JSON / JSONC files, and in the command palette. If the document has a syntax error, you get a warning with options to format anyway or jump to the error. Documents larger than 512 KB are formatted in a background thread, with a progress notification you can cancel.

### Tree view
Click the tree icon in the editor title to switch to the tree view. Click **Text** to switch back. The view toggles in place. 
Please note: If the document has unsaved changes, the other view opens in a second tab instead, because VS Code would otherwise ask you to save.

- Value types can be infered from its colors: keys in blue, strings in pink (shown without quotes while not editing), numbers in green, booleans in orange, `null` in grey.
- **Collapse All** / **Expand All**, and twisties on each object and array.
- **Filter** (`Ctrl/Cmd+F`) shows only the entries whose key or value matches, together with their parents. Matches are highlighted. `Esc` to clear the filter.
- Links: `Ctrl/Cmd+click` opens a URL.
- Drag the column divider to resize the key column.

#### Editing
All edits change the underlying document, so undo, redo, the dirty marker and saving work just as in the text editor. The right-click menu and the keyboard shortcuts below offer the same actions.

| Action | Mouse / keys |
|---|---|
| Edit value | double-click value, `Enter` |
| Rename key | double-click key, `F2` (`Tab` moves from key to value) |
| Add entry after the selected one | `Ctrl/Cmd+Enter` |
| Add child to an object or array | `Ctrl/Cmd+Shift+Enter` |
| Delete entry | `Delete`, or `Cmd+Backspace` on Mac |
| Copy value / path | `Ctrl/Cmd+C`, context menu |
| Navigate, expand, collapse | arrow keys, `Space`, `Home` / `End`, `PageUp` / `PageDown` |

Values are edited as JSON. `"text"` is a string, while `42`, `true`, `null` and `[1, 2]` are typed values. Any input that is not valid JSON is stored as a string, so you can usually type text without the quotes.

To always open `.json` files in the tree view, add this to your settings:
```json
"workbench.editorAssociations": { "*.json": "jsonFlex.view" }
```

## Settings

| Setting | Default | |
|---|---|---|
| `jsonFlex.prettify.maxInlineWidth` | `80` | Maximum line width for keeping short arrays and objects on one line. `0` always expands them. |
| `jsonFlex.prettify.inlineObjects` | `true` | Also keep short objects on one line, not just arrays. |
| `jsonFlex.prettify.indent` | `editor` | `editor`, `tab`, `2` or `4`. |
| `jsonFlex.tree.keyColumnWidth` | `260` | Initial width of the key column, in pixels. |

## Limits
- VS Code does **not** pass documents larger than 50 MB to extensions, so JSON Flex cannot work with them.
- The filter searches the raw text, so an escaped character like `\u00e9` does not match `é`.
- JSON5 features such as unquoted keys and single quotes are not supported. JSONC (comments and trailing commas) however is supported.

## Development
There are no dependencies and no build step.
Press F5 in VS Code to launch an Extension Development Host.
Run the tests with `npm test`, `npm run test:ui` and `npm run test:vscode`.
To package into an extension `.vsix` we use `npx @vscode/vsce package -o dist/`, which then can be installed via `menu → Install from VSIX`.

## License
BOML
