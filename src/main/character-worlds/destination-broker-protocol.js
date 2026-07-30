"use strict";

const BROKER_PROTOCOL_NAME = "lily.character-destination-broker";
const BROKER_PROTOCOL_VERSION = 1;

const DESTINATION_BROKER_PROTOCOL = Object.freeze({
  name: BROKER_PROTOCOL_NAME,
  version: BROKER_PROTOCOL_VERSION,
  capabilities: Object.freeze([
    "abortable_reserve",
    "bound_parent_identity",
    "bounded_deadline",
    "commit_outcome_reconcile",
    "compensated_reserve_abort",
    "create_only_reserve",
    "direct_reservation_inode",
    "opaque_reservation",
    "partial_visibility",
    "reservation_identity_release",
    "strict_basename",
    "transaction_commit",
  ]),
});

const DESTINATION_RESERVATION_PROTOCOL = Object.freeze({
  name: `${BROKER_PROTOCOL_NAME}.reservation`,
  version: BROKER_PROTOCOL_VERSION,
  capabilities: Object.freeze([
    "handle_scoped_write",
    "identity_scoped_release",
    "partial_visibility",
    "reconcile_commit_outcome",
    "separate_commit_point",
  ]),
});

function hasRequiredCapabilities(actual, required) {
  if (!Array.isArray(actual) || actual.length > 32) return false;
  const values = new Set(actual);
  return required.every((capability) => values.has(capability));
}

function validProtocol(actual, expected) {
  return Boolean(
    actual
    && actual.name === expected.name
    && actual.version === expected.version
    && hasRequiredCapabilities(actual.capabilities, expected.capabilities),
  );
}

function assertDestinationBrokerProtocol(broker) {
  if (
    !broker
    || typeof broker.reserve !== "function"
    || !validProtocol(broker.protocol, DESTINATION_BROKER_PROTOCOL)
  ) {
    throw new TypeError("CharacterDestinationWriter requires destination broker protocol v1");
  }
}

function assertDestinationReservationProtocol(reservation) {
  if (
    !reservation
    || Object.hasOwn(reservation, "targetPath")
    || !validProtocol(reservation.protocol, DESTINATION_RESERVATION_PROTOCOL)
    || typeof reservation.write !== "function"
    || typeof reservation.commit !== "function"
    || typeof reservation.reconcile !== "function"
    || typeof reservation.release !== "function"
  ) {
    throw new TypeError("Destination broker returned an invalid reservation protocol");
  }
}

module.exports = {
  BROKER_PROTOCOL_NAME,
  BROKER_PROTOCOL_VERSION,
  DESTINATION_BROKER_PROTOCOL,
  DESTINATION_RESERVATION_PROTOCOL,
  assertDestinationBrokerProtocol,
  assertDestinationReservationProtocol,
};
