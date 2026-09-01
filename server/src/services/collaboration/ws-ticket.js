import { createHash, randomBytes } from "node:crypto";

export const WS_TICKET_TTL_MS = 60_000;

function requiredId(value, label) {
  const id = String(value || "").trim();
  if (!id) throw new TypeError(`${label} is required.`);
  return id;
}

function ticketError() {
  const error = new Error("The collaboration websocket ticket is invalid, expired, or already consumed.");
  error.code = "COLLAB_WS_TICKET_INVALID";
  return error;
}

export function hashCollaborationWsTicket(ticket) {
  return createHash("sha256").update(String(ticket || ""), "utf8").digest("hex");
}

function createKyselyTicketRepository(db) {
  return {
    async withWriteTransaction(callback) { return db.transaction().execute(callback); },
    async issueWsTicket(trx, record) {
      const binding = await trx.selectFrom("user_devices").select("device_id")
        .where("user_id", "=", record.userId).where("device_id", "=", record.deviceId).where("status", "=", "active").executeTakeFirst();
      if (!binding) return null;
      await trx.insertInto("collaboration_ws_tickets").values({
        token_hash: record.tokenHash, user_id: record.userId, device_id: record.deviceId, expires_at: record.expiresAt,
      }).execute();
      return record;
    },
    async consumeWsTicket(trx, tokenHash, at) {
      return trx.updateTable("collaboration_ws_tickets as ticket")
        .set({ consumed_at: at })
        .where("ticket.token_hash", "=", tokenHash).where("ticket.consumed_at", "is", null).where("ticket.expires_at", ">", at)
        .where((eb) => eb.exists(eb.selectFrom("user_devices as device").select("device.device_id")
          .whereRef("device.user_id", "=", "ticket.user_id").whereRef("device.device_id", "=", "ticket.device_id").where("device.status", "=", "active")))
        .returning(["ticket.user_id as userId", "ticket.device_id as deviceId"]).executeTakeFirst();
    },
  };
}

async function withWrite(repository, callback) {
  return typeof repository.withWriteTransaction === "function" ? repository.withWriteTransaction(callback) : callback(repository);
}

export function createCollaborationWsTicketService({ db, repository = db ? createKyselyTicketRepository(db) : null, now = () => new Date(), createToken = () => randomBytes(32).toString("base64url") } = {}) {
  if (!repository) throw new TypeError("A collaboration websocket ticket repository is required.");
  return {
    async issue({ userId, deviceId } = {}) {
      const issuedAt = now();
      const ticket = String(createToken() || "");
      if (!ticket) throw new Error("Collaboration websocket ticket generation failed.");
      const record = { userId: requiredId(userId, "Collaboration account id"), deviceId: requiredId(deviceId, "Collaboration device id"), tokenHash: hashCollaborationWsTicket(ticket), expiresAt: new Date(issuedAt.getTime() + WS_TICKET_TTL_MS) };
      const stored = await withWrite(repository, (trx) => repository.issueWsTicket(trx, record));
      if (!stored) throw ticketError();
      return { ticket, expiresAt: record.expiresAt };
    },
    async consume({ ticket } = {}) {
      const rawTicket = String(ticket || "");
      if (!rawTicket) throw ticketError();
      const binding = await withWrite(repository, (trx) => repository.consumeWsTicket(trx, hashCollaborationWsTicket(rawTicket), now()));
      if (!binding) throw ticketError();
      return { userId: String(binding.userId ?? binding.user_id), deviceId: String(binding.deviceId ?? binding.device_id) };
    },
  };
}
