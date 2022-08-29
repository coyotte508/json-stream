import * as assert from "assert";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { describe } from "mocha";
import { BufferedString, getJsonString, getJsonValue, JsonStream, JsonStreamError, REGEX_NON_SPACE } from "./json-stream";

/* eslint-disable @typescript-eslint/no-invalid-this */

describe("JsonStream", () => {
	describe("BufferedString", () => {
		describe("positionAt", () => {
			it("should work with positive positions", () => {
				const str = new BufferedString("tru", "eeee");
				
				assert.deepStrictEqual(str.positionAt(1), { bufferIndex: 0, positionInBuffer: 1 });
				assert.deepStrictEqual(str.positionAt(3), { bufferIndex: 1, positionInBuffer: 0 });
				assert.deepStrictEqual(str.positionAt(4), { bufferIndex: 1, positionInBuffer: 1 });
				assert.deepStrictEqual(str.positionAt(2), { bufferIndex: 0, positionInBuffer: 2 });
				assert.deepStrictEqual(str.positionAt(2, str.positionAt(1)), { bufferIndex: 1, positionInBuffer: 0 });
				assert.deepStrictEqual(str.positionAt(1000), { bufferIndex: 2, positionInBuffer: 0 });
			});
			
			it("should work with negative positions", () => {
				const str = new BufferedString("tru", "eeee");
				
				assert.deepStrictEqual(str.positionAt(-3), { bufferIndex: 0, positionInBuffer: 0 });
				assert.deepStrictEqual(str.positionAt(-3, str.positionAt(4)), { bufferIndex: 0, positionInBuffer: 1 });
				assert.deepStrictEqual(str.positionAt(-3, str.positionAt(6)), { bufferIndex: 1, positionInBuffer: 0 });
			});
		});
		describe("last, end, firstChar", () => {
			it("last should work", () => {
				const str = new BufferedString("tru", "eeef");
				
				assert.deepStrictEqual(str.last, { bufferIndex: 1, positionInBuffer: 3 });
				assert.strictEqual(str.charAt(str.last), "f");
			});
			it("end should work", () => {
				const str = new BufferedString("tru", "eeee");
				
				assert.deepStrictEqual(str.end, { bufferIndex: 2, positionInBuffer: 0 });
			});
			it("firstChar should work", () => {
				const str = new BufferedString("tru", "eeee");
				
				assert.deepStrictEqual(str.firstChar, "t");
				str.advance(1);
				assert.deepStrictEqual(str.firstChar, "r");
				str.advance(1);
				assert.deepStrictEqual(str.firstChar, "u");
				str.advance(1);
				assert.deepStrictEqual(str.firstChar, "e");
			});
		});
		describe("indexOfFirstMatchingChar", () => {
			it("should work with only one argument", () => {
				const str = new BufferedString("tru", "eee");
				
				assert.deepStrictEqual(str.indexOfFirstMatchingChar(REGEX_NON_SPACE), { positionInBuffer: 0, bufferIndex: 0 });
				str.advance(1);
				assert.deepStrictEqual(str.indexOfFirstMatchingChar(REGEX_NON_SPACE), { positionInBuffer: 1, bufferIndex: 0 });
				str.advance(1);
				assert.deepStrictEqual(str.indexOfFirstMatchingChar(REGEX_NON_SPACE), { positionInBuffer: 2, bufferIndex: 0 });
				str.advance(1);
				assert.deepStrictEqual(str.indexOfFirstMatchingChar(REGEX_NON_SPACE), { positionInBuffer: 0, bufferIndex: 0 });
			});
		});
		describe("slice", () => {
			it("should be able to slice everything", () => {
				const str = new BufferedString("tru", "e");
				
				assert.strictEqual(str.slice(str.position, str.positionAt(4)), "true");
				assert.strictEqual(str.slice(str.position, str.positionAt(3)), "tru");
				assert.strictEqual(str.slice(str.positionAt(3), str.positionAt(4)), "e");
				assert.strictEqual(str.slice(str.position, str.end), "true");
			});
		});
	});
	describe("getJsonString", () => {
		it("should throw when specified start index is not a double quote", () => {
			assert.throws(() => getJsonString(new BufferedString('abc"def')), TypeError);
			assert.throws(() => getJsonString(new BufferedString('abc"def').advance(1)), TypeError);
			assert.throws(() => getJsonString(new BufferedString('abc"def').advance(2)), TypeError);
			getJsonString(new BufferedString('abc"def').advance(3));
			assert.throws(() => getJsonString(new BufferedString('abc"def').advance(4)), TypeError);
			getJsonString(new BufferedString('"abc"def'));
		});
		
		it("should return undefined when the end of the quote is not available", () => {
			assert.strictEqual(getJsonString(new BufferedString('abc"def').advance(3)).end, undefined);
			assert.strictEqual(getJsonString(new BufferedString('abc"def"').advance(7)).end, undefined);
			assert.strictEqual(getJsonString(new BufferedString('abc"def\\"').advance(3)).end, undefined);
		});
		
		it("should return the end of the quote", () => {
			assert.strictEqual(getJsonString(new BufferedString('abc"def"').advance(3)).end?.positionInBuffer, 7);
			const test = new BufferedString('abc"def"').advance(3);
			assert.strictEqual(test.slice(test.position, test.positionAt(1, getJsonString(test).end)), '"def"');
			assert.strictEqual(getJsonString(new BufferedString('"abc"def"').advance(4)).end?.positionInBuffer, 8);
			assert.strictEqual(getJsonString(new BufferedString('"abcdef"')).end?.positionInBuffer, 7);
		});
		
		it("should handle antislashes correctly", () => {
			assert.strictEqual(getJsonString(new BufferedString('abc"def\\""adazd"').advance(3)).end?.positionInBuffer, 9);
			assert.strictEqual(getJsonString(new BufferedString('abc"def\\\\"azddaz"').advance(3)).end?.positionInBuffer, 9);
		});
		
		it("should handle a more complex case", () => {
			const test = new BufferedString('{"description":"","summary":"Update README.md","parentCommit":"d347df3da573d4815a1437fd519fdd228d3c5a41",test:124}');
			assert.strictEqual(getJsonString(test.advance(1)).end?.positionInBuffer, 13);
		});
	});
	
	describe("getJsonValue", () => {
		it("should do a string", () => {
			const test = new BufferedString('{"description":"","summary":"Update README.md","parentCommit":"d347df3da573d4815a1437fd519fdd228d3c5a41"}');
			const { end } = getJsonValue(test.advance(1));
			assert.strictEqual(test.slice(test.position, test.positionAt(1, end)), '"description"');
		});
		
		it("should do an empty string", () => {
			const test = new BufferedString('{"description":"","summary":"Update README.md","parentCommit":"d347df3da573d4815a1437fd519fdd228d3c5a41"}');
			const { end } = getJsonValue(test.advance(15));
			assert.strictEqual(test.slice(test.position, test.positionAt(1, end)), '""');
		});
		
		it("should do a simple object", () => {
			const str = '{"description":"","summary":"Update README.md","parentCommit":"d347df3da573d4815a1437fd519fdd228d3c5a41","test":124}';
			const test = new BufferedString(str);
			const { end } = getJsonValue(test);
			assert.strictEqual(test.slice(test.position, test.positionAt(1, end)), str);
		});
		
		it("should error when quotes are missing in key", () => {
			const test = new BufferedString('{"description":"","summary":"Update README.md","parentCommit":"d347df3da573d4815a1437fd519fdd228d3c5a41",test:124}');
			assert.throws(() => getJsonValue(test), err => err instanceof JsonStreamError && err.message.includes('Expected " at position 105'));
		});
		
		it("should handle numbers", () => {
			const test = new BufferedString('{"description":15}');
			const { end } = getJsonValue(test.advance(15));
			assert.strictEqual(test.slice(test.position, test.positionAt(1, end)), "15");
		});
		
		it("should handle numbers with exponent", () => {
			const test = new BufferedString('{"description":95e+20}');
			const { end } = getJsonValue(test.advance(15));
			assert.strictEqual(test.slice(test.position, test.positionAt(1, end)), "95e+20");
		});
		
		it("should handle numbers with decimal", () => {
			const test = new BufferedString('{"description":0.234}');
			const { end } = getJsonValue(test.advance(15));
			assert.strictEqual(test.slice(test.position, test.positionAt(1, end)), "0.234");
		});
		
		it("should handle null", () => {
			const test = new BufferedString('{"description":nu', "ll}");
			const { end } = getJsonValue(test.advance(15));
			assert.strictEqual(test.slice(test.position, test.positionAt(1, end)), "null");
		});
		
		it("should handle false", () => {
			const test = new BufferedString('{"description":fa', "l", "se}");
			const { end } = getJsonValue(test.advance(15));
			assert.strictEqual(test.slice(test.position, test.positionAt(1, end)), "false");
		});
		
		it("should handle true", () => {
			const test = new BufferedString('{"description":true}');
			const { end } = getJsonValue(test.advance(15));
			assert.strictEqual(test.slice(test.position, test.positionAt(1, end)), "true");
		});
		
		it("should throw on unexpected literal", () => {
			const test = new BufferedString('{"description":undefined}');
			assert.throws(() => getJsonValue(test.advance(15)));
		});
		
		it("should throw on unexpected literal similar to existing literal", () => {
			const test = new BufferedString('{"description": truee}');
			assert.throws(() => getJsonValue(test));
			
			const test2 = new BufferedString('{"description": tru }');
			assert.throws(() => getJsonValue(test2.advance(15)));
		});
	});
	
	describe("JsonStream", () => {
		it("should do a simple object", async () => {
			const json = new JsonStream({
				description: JsonStream.collect({ maxChars: Infinity }),
			}, { maxBytes: Infinity });
			const items: any[] = [];
			
			const dest = async function *(source: typeof json) {
				for await (const item of source) {
					items.push(item);
				}
				yield "end";
			};
			
			await pipeline<any, any, any>(Readable.from(Buffer.from('{"description":""}')), json, dest);
			
			assert.deepStrictEqual(items, [{ path: "description", value: "" }]);
		});
		
		it("should do a simple object very chunked", async () => {
			const json = new JsonStream({
				description: JsonStream.collect({ maxChars: Infinity }),
			}, { maxBytes: Infinity, writableHighWaterMark: 2 });

			const items: any[] = [];
			
			const dest = async function *(source: typeof json) {
				for await (const item of source) {
					items.push(item);
				}
				yield "end";
			};
			
			const str = '{"description":"abcdef"}';
			
			const source = async function *() {
				for (let i = 0; i < str.length; i ++) {
					yield Buffer.from(str.slice(i, i + 1));
				}
			};
			
			await pipeline<any, any, any>(source, json, dest);
			
			assert.deepStrictEqual(items, [{ path: "description", value: "abcdef" }]);
		});
		
		it("should do a more complex object", async () => {
			const json = new JsonStream({
				description:  JsonStream.collect({ maxChars: Infinity }),
				summary:      JsonStream.collect({ maxChars: Infinity }),
				parentCommit: JsonStream.collect({ maxChars: Infinity }),
				files:        JsonStream.collectEach({ maxItemChars: Infinity }),
				lfsFiles:     JsonStream.collectEach({ maxItemChars: Infinity }),
				lfsFiles2:    JsonStream.collect({ maxChars: Infinity }),
			}, { maxBytes: Infinity });
			const items: any[] = [];
			
			const dest = async function *(source) {
				for await (const item of source) {
					items.push(item);
				}
				yield "end";
			};
			
			const source = Readable.from(Buffer.from(`
			{
				"description": "⚡️⚡️",
				"summary": "🔥 Update README.md",
				"parentCommit": "d347df3da573d4815a1437fd519fdd228d3c5a41",
				"files": [
					{
						"content": "---\\nextra_gated_prompt: |\\n la",
						"encoding": "utf-8",
						"path": "README.md"
					}, {
						"content": "---\\n⚡️⚡️sssssompt: |\\n la",
						"encoding": "utf-8",
						"path": "README2.md"
					}
				],
				"lfsFiles": [
					"ab", "cd", 12
				],
				"lfsFiles2": [
					"ab", "cd", 12
				]
			}
			
			`));
			
			await pipeline<any, any, any>(source, json, dest);
			
			assert.deepStrictEqual(items, [
				{ path: "description", value: "⚡️⚡️" },
				{ path: "summary", value: "🔥 Update README.md" },
				{ path: "parentCommit", value: "d347df3da573d4815a1437fd519fdd228d3c5a41" },
				{
					path:  "files",
					value: {
						content:  "---\nextra_gated_prompt: |\n la",
						encoding: "utf-8",
						path:     "README.md",
					},
				},
				{
					path:  "files",
					value: {
						content:  "---\n⚡️⚡️sssssompt: |\n la",
						encoding: "utf-8",
						path:     "README2.md",
					},
				},
				{ path: "lfsFiles", value: "ab" },
				{ path: "lfsFiles", value: "cd" },
				{ path: "lfsFiles", value: 12 },
				{ path: "lfsFiles2", value: ["ab", "cd", 12] },
			]);
		});
		
		it("should handle a large payload across multiple chunks of data", async function () {
			const json = new JsonStream({
				files: JsonStream.collectEach({ maxItemChars: Infinity }),
				obj:   JsonStream.collect({ maxChars: Infinity }),
			}, { maxBytes: Infinity });
			const items: any[] = [];
			
			const dest = async function *(source: typeof json) {
				for await (const item of source) {
					items.push(item);
				}
				yield "end";
			};
			
			const str = `
			{
				"files": [
					${["a", "b", "c", "d", "e", "f", "g"].map(ch => `{
						"path": "${ch.repeat(10)}",
						"content": "${ch.repeat(5_000_000)}"
					}`).join(",")}
				],
				"obj": {
					"aaa": "${"a".repeat(1_000_000)}",
					"bbb": "${"b".repeat(1_000_000)}",
					"ccc": "${"c".repeat(1_000_000)}",
					"ddd": "${"d".repeat(1_000_000)}",
					"eee": "${"e".repeat(1_000_000)}",
					"fff": "${"f".repeat(1_000_000)}",
					"ggg": "${"g".repeat(1_000_000)}"
				}
			}
			
			`;
			
			const source = async function *() {
				for (let i = 0; i < str.length; i += 16_384) {
					yield Buffer.from(str.slice(i, i + 16_384));
				}
			};
			
			await pipeline<any, any, any>(source, json, dest);
			
			assert.deepStrictEqual(items, [
				...["a", "b", "c", "d", "e", "f", "g"].map(ch => ({
					path:  "files",
					value: {
						path:    ch.repeat(10),
						content: ch.repeat(5_000_000),
					},
				})),
				{
					path:  "obj",
					value: {
						aaa: "a".repeat(1_000_000),
						bbb: "b".repeat(1_000_000),
						ccc: "c".repeat(1_000_000),
						ddd: "d".repeat(1_000_000),
						eee: "e".repeat(1_000_000),
						fff: "f".repeat(1_000_000),
						ggg: "g".repeat(1_000_000),
					},
				},
			]);
		});
	});
});
