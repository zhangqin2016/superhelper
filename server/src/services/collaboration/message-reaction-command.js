/**
 * The reaction command, factored out of `messages.js` so that file stays a
 * command registry.
 */
export function createReactToMessage({
  repository, commandRunner, commandOptions, commandError, validatedRecipients,
  requiredId, createId, requireRepositoryMethod,
} = {}) {
  /**
   * Toggle a reaction on a message.
   *
   * Deliberately NOT a message revision: a reaction must not bump
   * `messages.revision`, or every reaction would look like an edit to the
   * edit/revoke conflict detection and to reply snapshots. It is its own event
   * with its own projection, and older desktop clients skip the event type
   * while still advancing their cursor (see contracts.js).
   */
  return async function reactToMessage({
    account, clientCommandId, conversationId: rawConversationId, messageId: rawMessageId, emoji: rawEmoji, active,
    authorize, database, maxTransactionRetries,
  } = {}) {
    const conversationId = requiredId(rawConversationId, "Conversation id");
    const messageId = requiredId(rawMessageId, "Message id");
    const emoji = String(rawEmoji ?? "");
    // Bounded, and never interpreted: the server does not police WHICH emoji,
    // only that it is a short single token, so new emoji need no deploy.
    if (!emoji || [...emoji].length > 8 || emoji.length > 32 || /\s/.test(emoji)) {
      throw new TypeError("Reaction emoji must be a short whitespace-free token.");
    }
    const on = active !== false;
    const eventId = requiredId(createId("evt"), "Generated reaction event id");
    const input = { conversationId, messageId, emoji, active: on };
    return commandRunner(commandOptions({
      account, commandType: "message.reaction", clientCommandId, input, authorize, database, maxTransactionRetries, commandRunner,
      project: async ({ trx, account: actor }) => {
        const recipientUserIds = await validatedRecipients(repository, trx, conversationId);
        // The message must exist in THIS conversation; a reaction can never be
        // used to probe for message ids elsewhere.
        const target = await requireRepositoryMethod(repository, "findMessageForUpdate")(trx, { conversationId, messageId });
        if (!target) throw commandError("MESSAGE_NOT_FOUND", "The message no longer exists.");
        const response = { eventId, messageId, emoji, active: on };
        return {
          event: {
            id: eventId, conversationId, type: "message.reaction",
            payload: { messageId, emoji, active: on, userId: actor.userId },
          },
          recipientUserIds,
          response,
          project: async ({ trx: projectionTrx, event }) => {
            response.reactions = await requireRepositoryMethod(repository, "setMessageReaction")(projectionTrx, {
              conversationId, messageId, userId: actor.userId, emoji, active: on,
            });
            response.eventId = event.id;
          },
        };
      },
    }));
  }
}
