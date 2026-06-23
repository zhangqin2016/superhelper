import { z } from "zod";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";

// Tier/config groups. A group is just a named target for the existing config
// profiles (scope: "group"), so a model preset / runtime env / policy can be
// delivered to everyone in the group at once. Devices belong to a group either
// directly (devices.group_id) or by inheriting their license's group
// (licenses.group_id) — see resolveDeviceGroupId in public/client-config.js.

const groupSchema = z.object({
  id: z.string().min(2).max(80),
  name: z.string().min(1).max(160),
});

const assignSchema = z.object({
  kind: z.enum(["device", "license"]),
  id: z.string().min(1).max(160),
  groupId: z.string().max(80).optional().nullable(),
});

export function registerAdminConfigGroupRoutes(app, { audit }) {
  app.get(
    "/api/admin/config-groups",
    {
      schema: {
        tags: ["admin:config-groups"],
        summary: "List config groups",
        description: "Lists config groups with their device and license member counts.",
        response: { 200: okResponse({ groups: { type: "array", items: { type: "object" } } }) },
      },
    },
    async () => {
    const [groups, deviceCounts, licenseCounts] = await Promise.all([
      db.selectFrom("config_groups").selectAll().orderBy("name", "asc").limit(300).execute(),
      db
        .selectFrom("devices")
        .select(["group_id", (eb) => eb.fn.countAll().as("count")])
        .where("group_id", "is not", null)
        .groupBy("group_id")
        .execute(),
      db
        .selectFrom("licenses")
        .select(["group_id", (eb) => eb.fn.countAll().as("count")])
        .where("group_id", "is not", null)
        .groupBy("group_id")
        .execute(),
    ]);
    const deviceMap = new Map(deviceCounts.map((row) => [row.group_id, Number(row.count)]));
    const licenseMap = new Map(licenseCounts.map((row) => [row.group_id, Number(row.count)]));
    return {
      groups: groups.map((group) => ({
        ...group,
        deviceCount: deviceMap.get(group.id) || 0,
        licenseCount: licenseMap.get(group.id) || 0,
      })),
    };
  });

  app.post(
    "/api/admin/config-groups",
    {
      schema: {
        tags: ["admin:config-groups"],
        summary: "Create or update a config group",
        description: "Upserts a config group by id, setting its display name.",
        body: zodBody(groupSchema),
        response: { 201: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request, reply) => {
    const input = groupSchema.parse(request.body);
    await db
      .insertInto("config_groups")
      .values({ id: input.id, name: input.name })
      .onConflict((oc) => oc.column("id").doUpdateSet({ name: input.name }))
      .execute();
    await audit(request, "config_group.upsert", "config_group", input.id, { name: input.name });
    return reply.code(201).send({ ok: true, id: input.id });
  });

  app.delete(
    "/api/admin/config-groups/:id",
    {
      schema: {
        tags: ["admin:config-groups"],
        summary: "Delete a config group",
        description: "Detaches member devices and licenses, then deletes the group.",
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request) => {
    const groupId = request.params.id;
    // Detach members so nothing keeps pointing at a deleted group.
    await db.updateTable("devices").set({ group_id: null }).where("group_id", "=", groupId).execute();
    await db.updateTable("licenses").set({ group_id: null }).where("group_id", "=", groupId).execute();
    await db.deleteFrom("config_groups").where("id", "=", groupId).execute();
    await audit(request, "config_group.delete", "config_group", groupId);
    return { ok: true, id: groupId };
  });

  // Put a device or a license (customer/tier) into a group, or clear it (null).
  app.post(
    "/api/admin/config-groups/assign",
    {
      schema: {
        tags: ["admin:config-groups"],
        summary: "Assign a device or license to a group",
        description: "Sets or clears the group membership of a device or license.",
        body: zodBody(assignSchema),
        response: { 200: okResponse({ id: { type: "string" }, groupId: { type: "string" } }) },
      },
    },
    async (request, reply) => {
    const input = assignSchema.parse(request.body);
    const groupId = input.groupId || null;
    if (groupId) {
      const group = await db
        .selectFrom("config_groups")
        .select("id")
        .where("id", "=", groupId)
        .executeTakeFirst();
      if (!group) return reply.code(404).send({ ok: false, code: "CONFIG_GROUP_NOT_FOUND" });
    }
    const table = input.kind === "device" ? "devices" : "licenses";
    const result = await db
      .updateTable(table)
      .set({ group_id: groupId })
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!Number(result?.numUpdatedRows ?? 0)) {
      return reply.code(404).send({ ok: false, code: "TARGET_NOT_FOUND" });
    }
    await audit(request, "config_group.assign", input.kind, input.id, { groupId });
    return { ok: true, id: input.id, groupId };
  });
}
