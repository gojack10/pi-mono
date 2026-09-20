import { type Component, ScrollView, type ScrollViewScrollbar, VStack } from "@earendil-works/pi-tui";

export interface ChatViewportOptions {
	readonly document: Component;
	readonly pendingMessages: Component;
	readonly status: Component;
	readonly editor: Component;
	readonly footer: Component;
	readonly widgetsAbove?: Component;
	readonly widgetsBelow?: Component;
	readonly scrollbar?: ScrollViewScrollbar;
	readonly scrollbarTrackStyle?: (text: string) => string;
	readonly scrollbarThumbStyle?: (text: string) => string;
}

export interface ChatViewport {
	readonly root: Component;
	readonly transcript: ScrollView;
}

/** Shared fullscreen whole-document layout. */
export function createChatViewport(options: ChatViewportOptions): ChatViewport {
	const document = new VStack([
		options.document,
		options.pendingMessages,
		options.status,
		...(options.widgetsAbove === undefined ? [] : [options.widgetsAbove]),
		{ component: options.editor, minSize: 3 },
		...(options.widgetsBelow === undefined ? [] : [options.widgetsBelow]),
		{ component: options.footer, minSize: 1 },
	]);
	const transcript = new ScrollView(document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: options.scrollbar ?? "auto",
		...(options.scrollbarTrackStyle === undefined ? {} : { scrollbarTrackStyle: options.scrollbarTrackStyle }),
		...(options.scrollbarThumbStyle === undefined ? {} : { scrollbarThumbStyle: options.scrollbarThumbStyle }),
	});
	return { transcript, root: transcript };
}
