import type { ImageContent } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type ImagePasteContext = {
	pendingImageAttachments: Array<{ id: string; displayText: string; image: ImageContent }>;
	session: { prompt: (text: string, options: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }) => Promise<void> };
	formatPendingImageAttachment: (attachment: { displayText: string }) => string;
	consumePendingImageAttachmentsForText: (text: string) => Array<{ image: ImageContent }> | undefined;
	consumePendingImagesForText: (text: string) => ImageContent[] | undefined;
};

type InteractiveModePrototype = {
	promptSubmittedText(
		this: ImagePasteContext,
		text: string,
		options?: { streamingBehavior?: "steer" | "followUp" },
	): Promise<void>;
	formatPendingImageAttachment(this: ImagePasteContext, attachment: { displayText: string }): string;
	consumePendingImageAttachmentsForText(this: ImagePasteContext, text: string): Array<{ image: ImageContent }> | undefined;
	consumePendingImagesForText(this: ImagePasteContext, text: string): ImageContent[] | undefined;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode image paste", () => {
	it("submits matching pending image attachments with the prompt", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "abc" };
		const prompt = vi.fn(async () => {});
		const context: ImagePasteContext = {
			pendingImageAttachments: [{ id: "1", displayText: "[image #1: pasted.png]", image }],
			session: { prompt },
			formatPendingImageAttachment: interactiveModePrototype.formatPendingImageAttachment,
			consumePendingImageAttachmentsForText: interactiveModePrototype.consumePendingImageAttachmentsForText,
			consumePendingImagesForText: interactiveModePrototype.consumePendingImagesForText,
		};

		await interactiveModePrototype.promptSubmittedText.call(context, "describe [image #1: pasted.png]", {
			streamingBehavior: "followUp",
		});

		expect(prompt).toHaveBeenCalledWith("describe [image #1: pasted.png]", {
			streamingBehavior: "followUp",
			images: [image],
		});
		expect(context.pendingImageAttachments).toEqual([]);
	});
});
