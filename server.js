import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import multer from "multer";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.static(join(__dirname, "public")));
app.use(express.json({ limit: "50mb" }));

app.post("/api/chat", upload.array("images", 5), async (req, res) => {
  try {
    const { prompt, model } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const modelId =
      model === "opus" ? "claude-opus-4-6" : "claude-sonnet-4-6";

    const content = [];

    // Add uploaded images
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const base64 = file.buffer.toString("base64");
        const mediaType = file.mimetype;

        if (!mediaType.startsWith("image/")) {
          continue;
        }

        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64,
          },
        });
      }
    }

    content.push({ type: "text", text: prompt });

    // Use streaming for long responses
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const stream = await client.messages.stream({
      model: modelId,
      max_tokens: 16000,
      messages: [{ role: "user", content }],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    const finalMessage = await stream.finalMessage();
    res.write(
      `data: ${JSON.stringify({
        done: true,
        usage: {
          input_tokens: finalMessage.usage.input_tokens,
          output_tokens: finalMessage.usage.output_tokens,
        },
      })}\n\n`
    );
    res.end();
  } catch (err) {
    console.error("API error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
