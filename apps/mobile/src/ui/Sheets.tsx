/**
 * Two presentational sheets the transcript opens.
 *
 * `ImageViewer` is the Photos-style full-screen view: black ground, pinch to
 * zoom (the scroll view's native zoom, no gesture code), and floating glass
 * buttons for Close and Share.
 *
 * `SelectTextSheet` exists because the transcript cannot offer text selection
 * itself: a long press there opens the context menu, and React Native's
 * selectable `Text` only copies whole blocks on iOS. A read-only `TextInput`
 * gives the real selection handles and the system Copy/Look Up/Translate
 * menu, with `showSoftInputOnFocus` off so no keyboard appears.
 */

import { Image, Modal, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Glass } from "../Glass";
import { useTheme } from "../theme";
import Icon from "./Icon";

/** Keeps the buttons dark over the black viewer in either appearance. */
const VIEWER_TINT = "rgba(40,40,40,0.55)";

export function ImageViewer({ src, onClose }: { src: string | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={src !== null}
      animationType="fade"
      presentationStyle="overFullScreen"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.viewer}>
        <ScrollView
          style={StyleSheet.absoluteFill}
          contentContainerStyle={styles.viewerContent}
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          {src ? <Image source={{ uri: src }} style={styles.viewerImage} resizeMode="contain" /> : null}
        </ScrollView>
        <View style={[styles.viewerBar, { top: insets.top + 8 }]} pointerEvents="box-none">
          <Glass interactive tint={VIEWER_TINT} style={styles.viewerButton}>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={styles.fill}>
              <Icon name="xmark" size={16} weight="semibold" color="#ffffff" />
            </Pressable>
          </Glass>
          {src && !src.startsWith("data:") ? (
            <Glass interactive tint={VIEWER_TINT} style={styles.viewerButton}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Share image"
                onPress={() => void Share.share({ url: src })}
                style={styles.fill}
              >
                <Icon name="square.and.arrow.up" size={16} weight="semibold" color="#ffffff" />
              </Pressable>
            </Glass>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

export function SelectTextSheet({ text, onClose }: { text: string | null; onClose: () => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={text !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.sheet, { backgroundColor: theme.color.bg }]}>
        <View style={styles.sheetHead}>
          <Text style={[styles.sheetTitle, { color: theme.color.text }]}>Select Text</Text>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={10}>
            <Text style={[styles.sheetDone, { color: theme.color.accent }]}>Done</Text>
          </Pressable>
        </View>
        <TextInput
          value={text ?? ""}
          // Read-only in effect: edits are discarded because the value is
          // controlled, and no keyboard is shown to make them.
          onChangeText={() => undefined}
          multiline
          scrollEnabled
          showSoftInputOnFocus={false}
          caretHidden
          autoCorrect={false}
          spellCheck={false}
          style={[
            styles.sheetText,
            { color: theme.color.text, paddingBottom: insets.bottom + 24 },
          ]}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
  viewer: { flex: 1, backgroundColor: "#000000" },
  viewerContent: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
  viewerImage: { width: "100%", height: "100%" },
  viewerBar: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  viewerButton: { width: 44, height: 44, borderRadius: 22 },
  sheet: { flex: 1 },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 10,
  },
  sheetTitle: { fontSize: 17, fontWeight: "600" },
  sheetDone: { fontSize: 17, fontWeight: "600" },
  sheetText: { flex: 1, fontSize: 17, lineHeight: 24, paddingHorizontal: 20, textAlignVertical: "top" },
});
