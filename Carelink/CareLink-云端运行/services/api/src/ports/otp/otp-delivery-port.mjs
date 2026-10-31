import { assert } from "../../errors.mjs";

export function assertOtpDeliveryPort(port) {
  assert(port && typeof port.name === "string" && port.name.length >= 1 && port.name.length <= 100 &&
    typeof port.deliver === "function", "otp_delivery_provider_invalid", 503);
  return port;
}

export function otpSinkDeliveryPort(sink) {
  assert(typeof sink === "function", "otp_delivery_provider_invalid", 503);
  return { name: "local_sink", deliver: (message) => sink(message) };
}
