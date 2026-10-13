import { Text, View } from "react-native";
import { mdBlocks, type Inline } from "../shared/markdown.ts";

// The answer of a side question is markdown; the panel is React Native. The parser lives in shared/markdown.ts (tested there) —
// this only maps its blocks to Text with the panel's styles, so an answer reads like the one in the main window.
export function Markdown({ text, styles }: { text: string; styles: Record<string, object> }) {
  const inline = (parts: Inline[]) =>
    parts.map((part, j) => (
      <Text key={j} style={part.bold ? styles.bold : part.code ? styles.codeInline : undefined}>
        {part.text}
      </Text>
    ));
  return (
    <View style={{ gap: 4 }}>
      {mdBlocks(text).map((block, i) =>
        block.kind === "code" ? (
          <Text key={i} style={[styles.text, styles.code]}>
            {block.text}
          </Text>
        ) : (
          <Text key={i} style={block.kind === "heading" ? [styles.text, styles.heading] : styles.text}>
            {block.kind === "item" && `${block.marker} `}
            {inline(block.text)}
          </Text>
        ),
      )}
    </View>
  );
}
