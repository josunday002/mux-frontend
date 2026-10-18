import { describe, expect, it } from "vitest";
import {
	evaluateSendFlowGate,
	parseKillSwitch,
	parseOptInFlag,
	readClientSendFlowFlags,
	readServerSendFlowFlags,
	SEND_GATE_CODES,
	type SendFlowFlags,
} from "./send-flows";

describe("parseOptInFlag", () => {
	it("returns false for undefined and empty string", () => {
		expect(parseOptInFlag(undefined)).toBe(false);
		expect(parseOptInFlag("")).toBe(false);
	});

	it("returns true only for true/1 (case- and whitespace-insensitive)", () => {
		expect(parseOptInFlag("true")).toBe(true);
		expect(parseOptInFlag("TRUE")).toBe(true);
		expect(parseOptInFlag(" 1 ")).toBe(true);
	});

	it("returns false for unrecognized or falsy values", () => {
		expect(parseOptInFlag("yes")).toBe(false);
		expect(parseOptInFlag("0")).toBe(false);
		expect(parseOptInFlag("false")).toBe(false);
		expect(parseOptInFlag("FALSE")).toBe(false);
		expect(parseOptInFlag("off")).toBe(false);
		expect(parseOptInFlag("typo")).toBe(false);
	});
});

describe("parseKillSwitch", () => {
	it("returns false for undefined and empty string", () => {
		expect(parseKillSwitch(undefined)).toBe(false);
		expect(parseKillSwitch("")).toBe(false);
	});

	it("returns false for false/0 (case- and whitespace-insensitive)", () => {
		expect(parseKillSwitch("false")).toBe(false);
		expect(parseKillSwitch("FALSE")).toBe(false);
		expect(parseKillSwitch(" 0 ")).toBe(false);
	});

	it("fails closed for unrecognized values", () => {
		expect(parseKillSwitch("typo")).toBe(true);
		expect(parseKillSwitch("true")).toBe(true);
		expect(parseKillSwitch("TRUE")).toBe(true);
		expect(parseKillSwitch(" 1 ")).toBe(true);
		expect(parseKillSwitch("yes")).toBe(true);
		expect(parseKillSwitch("off")).toBe(true);
	});
});

describe("evaluateSendFlowGate", () => {
	const base: SendFlowFlags = {
		enabled: true,
		killSwitch: false,
		mainnetEnabled: false,
		network: "testnet",
	};

	it("allows a testnet send when enabled", () => {
		expect(evaluateSendFlowGate(base)).toEqual({
			allowed: true,
			code: SEND_GATE_CODES.OK,
			network: "testnet",
		});
	});

	it("kill switch wins over everything", () => {
		expect(evaluateSendFlowGate({ ...base, killSwitch: true })).toEqual({
			allowed: false,
			code: SEND_GATE_CODES.KILL_SWITCH_ENGAGED,
		});
	});

	it("denies when not enabled", () => {
		expect(evaluateSendFlowGate({ ...base, enabled: false })).toEqual({
			allowed: false,
			code: SEND_GATE_CODES.DISABLED,
		});
	});

	it("denies when network is misconfigured", () => {
		expect(evaluateSendFlowGate({ ...base, network: null })).toEqual({
			allowed: false,
			code: SEND_GATE_CODES.NETWORK_MISCONFIGURED,
		});
	});

	it("denies mainnet sends unless mainnet is enabled", () => {
		expect(evaluateSendFlowGate({ ...base, network: "mainnet" })).toEqual({
			allowed: false,
			code: SEND_GATE_CODES.MAINNET_NOT_ENABLED,
		});
		expect(
			evaluateSendFlowGate({
				...base,
				network: "mainnet",
				mainnetEnabled: true,
			}),
		).toEqual({
			allowed: true,
			code: SEND_GATE_CODES.OK,
			network: "mainnet",
		});
	});

	it("denies a requested network that does not match config", () => {
		expect(evaluateSendFlowGate(base, "mainnet")).toEqual({
			allowed: false,
			code: SEND_GATE_CODES.NETWORK_MISMATCH,
		});
	});
});

describe("readServerSendFlowFlags", () => {
	it("reads server-only MUX_* flags", () => {
		const flags = readServerSendFlowFlags({
			MUX_SEND_FLOWS_ENABLED: "true",
			MUX_SEND_KILL_SWITCH: "false",
			MUX_SEND_MAINNET_ENABLED: "1",
			MUX_STELLAR_NETWORK: "mainnet",
		});
		expect(flags).toEqual({
			enabled: true,
			killSwitch: false,
			mainnetEnabled: true,
			network: "mainnet",
		});
	});

	it("fails closed on unknown network", () => {
		const flags = readServerSendFlowFlags({ MUX_STELLAR_NETWORK: "bogus" });
		expect(flags.network).toBeNull();
	});
});

describe("readClientSendFlowFlags", () => {
	it("reads NEXT_PUBLIC_* flags", () => {
		const original = { ...process.env };
		process.env.NEXT_PUBLIC_SEND_FLOWS_ENABLED = "1";
		process.env.NEXT_PUBLIC_SEND_KILL_SWITCH = "0";
		process.env.NEXT_PUBLIC_SEND_MAINNET_ENABLED = "false";
		process.env.NEXT_PUBLIC_STELLAR_NETWORK = "testnet";
		try {
			const flags = readClientSendFlowFlags();
			expect(flags).toEqual({
				enabled: true,
				killSwitch: false,
				mainnetEnabled: false,
				network: "testnet",
			});
		} finally {
			process.env = original;
		}
	});
});
