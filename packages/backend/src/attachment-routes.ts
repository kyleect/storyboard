import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { detectAttachment, MAX_ATTACHMENT_BYTES } from "./attachment-types.js";
import type { Store } from "./store.js";

/*
 * Routes for files attached to messages:
 *
 *   POST /api/sessions/:id/attachments?name=   upload one file
 *   GET  /api/attachments/:id                  its bytes
 *
 * An upload is the file itself as the request body, with its media type as
 * the Content-Type (images and audio only, see attachment-types.ts). It
 * answers 201 with the attachment's description, whose `id` goes in
 * `attachmentIds` when the message is sent. 404 when the session does not
 * exist, 409 when it is in the trash, 400 for an empty file or one that is
 * not what its media type says, 413 over the size limit, 415 for a media
 * type that is not accepted. The download is served with its stored media
 * type and `nosniff`; it needs the same token as every /api route.
 */

const IdParams = z.object({ id: z.string() });

export function registerAttachmentRoutes(
  app: FastifyInstance,
  deps: { store: Store; newId: () => string; now: () => string },
) {
  const { store, newId, now } = deps;

  // Without this, Fastify refuses image and audio bodies. The body stays a
  // Buffer; the route checks what it holds.
  app.addContentTypeParser(
    /^(image|audio)\//,
    { parseAs: "buffer", bodyLimit: MAX_ATTACHMENT_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.post(
    "/api/sessions/:id/attachments",
    { bodyLimit: MAX_ATTACHMENT_BYTES },
    async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const { name } = z
        .object({ name: z.string().min(1).max(255).optional() })
        .parse(req.query);
      const session = store.getSession(id);
      if (!session)
        return reply.code(404).send({ error: "Session not found." });
      if (session.trashed_at !== null)
        return reply.code(409).send({ error: "The session is in the trash." });

      const body = req.body;
      // Fastify's own parsers turn text and JSON bodies into strings and
      // objects; only an image or audio Content-Type gives the raw bytes.
      if (body !== undefined && !Buffer.isBuffer(body))
        return reply.code(415).send({
          error:
            "Send the file itself as the request body, with its media type as the Content-Type.",
        });
      if (body === undefined || body.length === 0)
        return reply.code(400).send({ error: "The file is empty." });
      const found = detectAttachment(req.headers["content-type"] ?? "", body);
      if (!found)
        return reply.code(400).send({
          error:
            "The file is not a PNG, JPEG, GIF or BMP image, or a WAV, MP3 or FLAC audio file, or its content does not match its type.",
        });

      const attachment = store.addAttachment(
        id,
        newId(),
        { ...found, ...(name !== undefined ? { name } : {}), data: body },
        now(),
      );
      return reply.code(201).send(attachment);
    },
  );

  app.get("/api/attachments/:id", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const file = store.getAttachmentData(id);
    if (!file) return reply.code(404).send({ error: "Attachment not found." });
    return (
      reply
        .header("content-type", file.mediaType)
        .header("x-content-type-options", "nosniff")
        // The bytes under an id never change.
        .header("cache-control", "private, max-age=31536000, immutable")
        .send(file.data)
    );
  });
}
