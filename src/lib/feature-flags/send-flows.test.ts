import { describe, expect, it } from "vitest";
import {
	evaluateSendFlowGate,
	parseKillSwitch,
	parseNetwork,
	parseOptInFlag,
	readServerSendFlowFlags,
	SEND_GATE_CODES,
	type SendFlowFlags,
} from "./send-flows";

const baseFlags: SendFlowFlags = {
	enabled: true,
	killSwitch: false,
	mainnetEnabled: false,
	network: "testnet",
};

describe("parseOptInFlag", () => {
	it("only enables on explicit true/1", () => {
		expect(parseOptInFlag("true")).toBe(true);
		expect(parseOptInFlag("1")).toBe(true);
		expect(parseOptInFlag(" TRUE ")).toBe(true);
		expect(parseOptInFlag("false")).toBe(false);
		expect(parseOptInFlag("0")).toBe(false);
		expect(parseOptInFlag("yes")).toBe(false);
		expect(parseOptInFlag(undefined)).toBe(false);
	});
});

describe("parseKillSwitch", () => {
	it("fails closed on anything but false/0/unset", () => {
		expect(parseKillSwitch(undefined)).toBe(false);
		expect(parseKillSwitch("")).toBe(false);
		expect(parseKillSwitch("false")).toBe(false);
		expect(parseKillSwitch("0")).toBe(false);
		expect(parseKillSwitch("true")).toBe(true);
		expect(parseKillSwitch("typo")).toBe(true);
	});
});

describe("parseNetwork", () => {
	it("maps known networks and aliases", () => {
		expect(parseNetwork("testnet")).toBe("testnet");
		expect(parseNetwork("futurenet")).toBe("futurenet");
		expect(parseNetwork("mainnet")).toBe("mainnet");
		expect(parseNetwork("public")).toBe("mainnet");
		expect(parseNetwork("PUBLIC")).toBe("mainnet");
	});

	it("returns null for unknown or missing values", () => {
		expect(parseNetwork(undefined)).toBeNull();
		expect(parseNetwork("")).toBeNull();
		expect(parseNetwork("devnet")).toBeNull();
	});
});

describe("readServerSendFlowFlags", () => {
	it("reads MUX_* flags and configured network", () => {
		const flags = readServerSendFlowFlags({
			MUX_SEND_FLOWS_ENABLED: "true",
			MUX_SEND_KILL_SWITCH: "false",
			MUX_SEND_MAINNET_ENABLED: "1",
			MUX_STELLAR_NETWORK: "public",
		});
		expect(flags).toEqual({
			enabled: true,
			killSwitch: false,
			mainnetEnabled: true,
			network: "mainnet",
		});
	});
});

describe("evaluateSendFlowGate", () => {
	it("allows a testnet send when enabled", () => {
		expect(evaluateSendFlowGate(baseFlags)).toEqual({
			allowed: true,
			code: SEND_GATE_CODES.OK,
			network: "testnet",
		});
	});

	it("rejects when the kill switch is engaged", () => {
		expect(evaluateSendFlowGate({ ...baseFlags, killSwitch: true })).toEqual({
			allowed: false,
			code: SEND_GATE_CODES.KILL_SWITCH_ENGAGED,
		});
	});

	it("rejects when send flows are disabled", () => {
		expect(evaluateSendFlowGate({ ...baseFlags, enabled: false })).toEqual({
			allowed: false,
			code: SEND_GATE_CODES.DISABLED,
		});
	});

	it("rejects when the network is misconfigured", () => {
		expect(evaluateSendFlowGate({ ...baseFlags, network: null })).toEqual({
			allowed: false,
			code: SEND_GATE_CODES.NETWORK_MISCONFIGURED,
		});
	});

	it("rejects mainnet sends unless mainnet is enabled", () => {
		expect(
			evaluateSendFlowGate({
				...baseFlags,
				network: "mainnet",
				mainnetEnabled: false,
			}),
		).toEqual({ allowed: false, code: SEND_GATE_CODES.MAINNET_NOT_ENABLED });
	});

	it("allows mainnet sends when mainnet is enabled", () => {
		expect(
			evaluateSendFlowGate({
				...baseFlags,
				network: "mainnet",
				mainnetEnabled: true,
			}),
		).toEqual({
			allowed: true,
			code: SEND_GATE_CODES.OK,
			network: "mainnet",
		});
	});

	it("rejects a requested network that differs from the configured one", () => {
		expect(
			evaluateSendFlowGate({ ...baseFlags, network: "testnet" }, "mainnet"),
		).toEqual({ allowed: false, code: SEND_GATE_CODES.NETWORK_MISMATCH });
	});

	it("accepts 'public' as a mainnet alias when configured for mainnet", () => {
		expect(
			evaluateSendFlowGate(
				{ ...baseFlags, network: "mainnet", mainnetEnabled: true },
				"public",
			),
		).toEqual({
			allowed: true,
			code: SEND_GATE_CODES.OK,
			network: "mainnet",
		});
	});

	it("rejects 'public' with a network mismatch when configured for testnet", () => {
		expect(
			evaluateSendFlowGate({ ...baseFlags, network: "testnet" }, "public"),
		).toEqual({ allowed: false, code: SEND_GATE_CODES.NETWORK_MISMATCH });
	});

	it("normalizes mixed-case requested networks before comparison", () => {
		expect(
			evaluateSendFlowGate({ ...baseFlags, network: "testnet" }, "TESTNET"),
		).toEqual({
			allowed: true,
			code: SEND_GATE_CODES.OK,
			network: "testnet",
		});
	});
});
