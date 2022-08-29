import type { DuplexOptions } from "stream";
import { Duplex } from "stream";
import { StringDecoder } from "string_decoder";
// Could use Joi's schemas directly

// const schema = {
// 	summary:      JsonStream.collect({ maxChars: 1_000 }),
// 	description:  JsonStream.collect({ maxChars: 100_000 }),
// 	parentCommit: JsonStream.collect({ maxChars: 1_000 }),
// 	lfsFiles:     JsonStream.collectEach({ maxItemChars: 1_000 }),
// 	deletedFiles: JsonStream.collectEach({ maxItemChars: 1_000 }),
// 	files:        JsonStream.collectEach({ maxItemChars: 13_000_000 }),
// };


// for await (const item of pipeline(req.body, new JsonStream(schema, {maxBytes: 1_000_000_000}))) {
// 	// item.path: "summary" | "description" | "parentCommit" | ..., item.value: any
// }

const MAX_KEY_LENGTH = 1000;
const MAX_NUMBER_LENGTH = 1000;
const MAX_JSON_DEPTH = 100;
export const REGEX_NON_SPACE = /\S/;
const REGEX_NON_NUMERICAL_STRING = /[^0-9.Ee+]/;
const REGEX_ANTISLASH_OR_END_QUOTE = /["\\]/;

enum ParsingState {
	ExpectingStartingCurlyBrace,
	ExpectingTopLevelKey,
	ExpectingTopLevelSemiColon,
	ExpectingTopLevelData,
	ExpectingTopLevelArray,
	ExpectingArrayCommaOrEnd,
	ExpectingTopLevelCommaOrEnd,
	JsonEnded,
}

export class JsonStreamError extends Error {
	httpStatusCode: number = 400;
}

interface BufferedPosition {
	bufferIndex: number;
	positionInBuffer: number;
}

namespace BufferedPosition {
	export function equals(p1: BufferedPosition, p2: BufferedPosition): boolean {
		return p1.bufferIndex === p2.bufferIndex && p1.positionInBuffer === p2.positionInBuffer;
	}
}

export class BufferedString {
	private buffers: string[] = [];
	position: BufferedPosition = {
		bufferIndex:      0,
		positionInBuffer: 0,
	};
	
	size = 0;
	
	constructor(...strs: string[]) {
		this.buffers = strs;
		this.size = this.buffers.reduce((acc, current) => acc + current.length, 0);
	}
	
	push(str: string): void {
		this.buffers.push(str);
		this.size += str.length;
	}
	
	indexOfChar(char: string, position = this.position): BufferedPosition | undefined {
		if (char.length !== 1) {
			throw new TypeError("char must be a single character");
		}
		
		for (let i = position.bufferIndex; i < this.buffers.length; i++) {
			const idx = this.buffers[i].indexOf(char);
			
			if (idx !== -1) {
				return {
					bufferIndex:      i,
					positionInBuffer: idx,
				};
			}
		}
		
		return undefined;
	}
	
	/**
	 * @param regex - a regex with granularity of 1 char, i.e. that can only match individual chars and not a sequence of characters.
	 * @param position - Optional position at which to start the search, similar to {@link String.indexOf}
	 */
	indexOfFirstMatchingChar(regex: RegExp, position = this.position): BufferedPosition | undefined {
		if (this.size === 0 || position.bufferIndex >= this.buffers.length) {
			return undefined;
		}
		
		const pos = this.buffers[position.bufferIndex].slice(position.positionInBuffer).search(regex);
		
		if (pos !== -1) {
			return {
				bufferIndex:      position.bufferIndex,
				positionInBuffer: pos + position.positionInBuffer,
			};
		}
		
		for (let i = position.bufferIndex + 1; i < this.buffers.length; i++) {
			const idx = this.buffers[i].search(regex);
			
			if (idx !== -1) {
				return {
					bufferIndex:      i,
					positionInBuffer: idx,
				};
			}
		}
	}
	
	clear(): void {
		this.buffers = [];
		this.size = 0;
		this.position = {
			bufferIndex:      0,
			positionInBuffer: 0,
		};
	}
	
	/**
	 * Seek to new position and discard previous buffers
	 * @param position 
	 */
	seek(position: BufferedPosition): this {
		this.shiftBuffers(position.bufferIndex);
		
		this.position.positionInBuffer = position.positionInBuffer;
		
		return this;
	}
	
	positionAt(offset: number, startingPosition = this.position): BufferedPosition {
		if (offset < 0) {
			if (startingPosition.positionInBuffer + offset >= 0) {
				return {
					positionInBuffer: startingPosition.positionInBuffer + offset,
					bufferIndex:      startingPosition.bufferIndex,
				};
			}
			
			let remaining = offset + startingPosition.positionInBuffer;
			
			let bufIdx = startingPosition.bufferIndex - 1;
			for (; bufIdx >= 0 && remaining + this.buffers[bufIdx].length < 0; bufIdx--) {
				remaining += this.buffers[bufIdx].length;
			}
		
			return {
				bufferIndex:      Math.max(bufIdx, 0),
				positionInBuffer: bufIdx < 0 ? 0 : remaining + this.buffers[bufIdx].length,
			};
		}
		const startingBuffer = this.buffers[startingPosition.bufferIndex];
		if (startingPosition.positionInBuffer + offset < startingBuffer.length) {
			return {
				bufferIndex:      startingPosition.bufferIndex,
				positionInBuffer: startingPosition.positionInBuffer + offset,
			};
		}
		
		let remaining = offset - (this.buffers[startingPosition.bufferIndex].length - startingPosition.positionInBuffer);
			
		let bufIdx = startingPosition.bufferIndex + 1;
		for (; bufIdx < this.buffers.length && remaining >= this.buffers[bufIdx].length; bufIdx++) {
			remaining -= this.buffers[bufIdx].length;
		}
		
		return {
			bufferIndex:      bufIdx,
			positionInBuffer: bufIdx < this.buffers.length ? remaining : 0,
		};
	}
	
	advance(n: number): this {
		return this.seek(this.positionAt(n));
	}
	
	slice(start: BufferedPosition, end: BufferedPosition = this.end): string {
		if (start.bufferIndex === end.bufferIndex) {
			return this.buffers[start.bufferIndex].slice(start.positionInBuffer, end.positionInBuffer);
		}
		
		const strs: string[] = [this.buffers[start.bufferIndex].slice(start.positionInBuffer)];
		
		for (let i = start.bufferIndex + 1; i < end.bufferIndex; i++) {
			strs.push(this.buffers[i]);
		}
		
		if (end.bufferIndex < this.buffers.length) {
			strs.push(this.buffers[end.bufferIndex].slice(0, end.positionInBuffer));
		}
		
		return strs.join("");
	}
	
	numOfChars(start: BufferedPosition, end: BufferedPosition): number {
		if (start.bufferIndex === end.bufferIndex) {
			return end.positionInBuffer - start.positionInBuffer;
		}
		
		let sum = this.buffers[start.bufferIndex].length - start.positionInBuffer;
		
		for (let i = start.bufferIndex + 1; i < end.bufferIndex; i++) {
			sum += this.buffers[i].length;
		}
		
		return sum + end.positionInBuffer;
	}
	
	get firstChar(): string {
		return this.charAt(this.position);
	}
	
	charAt(position: BufferedPosition): string {
		return this.buffers[position.bufferIndex][position.positionInBuffer];
	}
	
	/**
	 * Returns the position of the last character of the string
	 */
	get last(): BufferedPosition {
		return {
			bufferIndex:      this.buffers.length - 1,
			positionInBuffer: this.buffers[this.buffers.length - 1].length - 1,
		};
	}
	
	/**
	 * Return a position after the end of the string, as opposed to {@link last} which
	 * returns the position of the last character
	 */
	get end(): BufferedPosition {
		return {
			bufferIndex:      this.buffers.length,
			positionInBuffer: 0,
		};
	}
	
	get offset(): number {
		return this.offsetAt(this.position);
	}
	
	offsetAt(position: BufferedPosition): number {
		return this.numOfChars({ bufferIndex: 0, positionInBuffer: 0 }, position);
	}
	
	/**
	 * Remove buffers at the beginning.
	 */
	private shiftBuffers(n: number): void {
		if (n > 0) {
			const removedBufferSize = this.buffers.slice(0, n).reduce((acc, current) => acc + current.length, 0);
			this.size -= removedBufferSize;
			this.buffers.splice(0, n);
			this.position.bufferIndex = this.position.bufferIndex - n;
			if (this.position.bufferIndex < 0) {
				this.position.bufferIndex = 0;
				this.position.positionInBuffer = 0;
			}
		}
	}
}

export class JsonStream<T extends Record<string, JsonStream.Schema>> extends Duplex {
	#getMoreData: ((err?: Error) => void) | null = null;
	#data = new BufferedString();
	#noMoreData = false;
	#canOutputData = false;
	#schema: T;
	#decoder = new StringDecoder("utf-8");
	#done = false; // Shouldn't be needed, just for extra safety
	
	#state = ParsingState.ExpectingStartingCurlyBrace;
	#currentKey: keyof T | null = null;
	
	#currentlyReadBytes = 0;
	#currentlyReadChars = 0;
	#jsonValueIntermediateState: IntermediateState | undefined;
	
	public maxBytes: number;
	
	[Symbol.asyncIterator](): AsyncIterableIterator<{ path: keyof T; value: unknown; }> {
		return super[Symbol.asyncIterator]();
	}
	
	constructor(schema: T, opts: { maxBytes: number; } & DuplexOptions) {
		super({ objectMode: true, ...opts });
		this.#schema = schema;
		this.maxBytes = opts.maxBytes;
	}
	
	get #debugOffset() {
		return this.#currentlyReadChars - this.#data.size;
	}

	public override _write(chunk: Buffer, encoding: string, callback: () => void): void {
		if (this.#state === ParsingState.JsonEnded) {
			callback();
			return;
		}
		
		this.#getMoreData = callback;
		
		const decoded = this.#decoder.write(chunk);
		this.#data.push(decoded);
		this.#currentlyReadBytes += chunk.byteLength;
		this.#currentlyReadChars += decoded.length;
		
		if (this.#currentlyReadBytes > this.maxBytes) {
			const err = new JsonStreamError("Total size of JSON payload above maximum size of " + this.maxBytes.toLocaleString());
			err.httpStatusCode = 413;
			throw err;
		}
		
		this.processData();
	}

	public override _final(callback: () => void): void {
		this.#noMoreData = true;

		callback();

		this.processData();
	}

	public override _read(size: number): void {
		this.#canOutputData = true;

		this.processData();
	}

	private processData() {
		if (this.#done) {
			return;
		}
		
		while (this.#canOutputData && this.#state !== ParsingState.JsonEnded) {
			try {
				const nonSpacePos = this.#data.indexOfFirstMatchingChar(REGEX_NON_SPACE);
				
				if (!nonSpacePos) {
					this.#data.clear();
					break; // need more data
				}
				
				this.#data.seek(nonSpacePos);
				
				const char = this.#data.firstChar;
				
				if (this.#state === ParsingState.ExpectingStartingCurlyBrace) {
					if (char !== "{") {
						throw new JsonStreamError(`JSON error: Expected { at position ${this.#debugOffset + this.#data.offset}`);
					}
					
					this.#data.advance(1);
					this.#state = ParsingState.ExpectingTopLevelKey;
					continue;
				}
				
				if (this.#state === ParsingState.ExpectingTopLevelKey) {
					if (char !== '"') {
						throw new JsonStreamError(`JSON error: Expected " at position ${this.#debugOffset + this.#data.offset}, got ${char}`);
					}
					
					const { end: endingQuote } = getJsonString(this.#data);
					
					if (endingQuote === undefined) {
						if (this.#data.size - this.#data.offset >= MAX_KEY_LENGTH + 2) {
							throw new JsonStreamError("Top-level object keys can be of maximum size " + MAX_KEY_LENGTH.toLocaleString());
						}
						break; // Need more data
					}
					
					this.#currentKey = this.#data.slice(this.#data.positionAt(1), endingQuote);
					this.#data.seek(endingQuote);
					this.#data.advance(1);
					this.#state = ParsingState.ExpectingTopLevelSemiColon;
					
					if (!(this.#currentKey in this.#schema)) {
						throw new JsonStreamError("Unknown top-level key: " + (this.#currentKey as string));
						// ^ Alternative is to ignore the content of the unknown key. That would mean, in case the content is very long,
						// storing the succession of '{' and '['  to be able to detect when the content ends, without storing it all in 
						// this.#buffer
					}
					continue;
				}
				
				if (this.#state === ParsingState.ExpectingTopLevelSemiColon) {
					if (char !== ":") {
						throw new JsonStreamError(`JSON error: Expected : at position ${this.#debugOffset + this.#data.offset}`);
					}
					
					this.#data.advance(1);
					
					this.#state = this.#schema[this.#currentKey as keyof T].extractArrayItems ? ParsingState.ExpectingTopLevelArray : ParsingState.ExpectingTopLevelData;
					continue;
				}
				
				if (this.#state === ParsingState.ExpectingTopLevelArray) {
					if (char !== "[") {
						throw new JsonStreamError(`JSON error: Expected [ at position ${this.#debugOffset + this.#data.offset}`);
					}
					
					this.#data.advance(1);
					
					this.#state = ParsingState.ExpectingTopLevelData;
					continue;
				}
				
				if (this.#state === ParsingState.ExpectingTopLevelData) {
					const maxSize = this.#schema[this.#currentKey!].maxSize;
					const { end, intermediateState } = getJsonValue(this.#data, {
						debugCharOffset:   this.#debugOffset,
						intermediateState: this.#jsonValueIntermediateState,
					});
					this.#jsonValueIntermediateState = intermediateState;
					
					if (end === undefined) {
						if (this.#data.size - this.#data.offset >= maxSize) {
							const err = new JsonStreamError(`JSON value for key ${this.#currentKey as string} is of length higher than ${maxSize.toLocaleString()}`);
							err.httpStatusCode = 413;
							throw err;
						}
						
						break; // Need more data
					}
					
					if (this.#data.numOfChars(this.#data.position, end) >= maxSize) {
						const err = new JsonStreamError(`JSON value for key ${this.#currentKey as string} is of length higher than ${maxSize.toLocaleString()}`);
						err.httpStatusCode = 413;
						throw err;
					}
					
					const pushResult = this.push({
						path:  this.#currentKey,
						value: JSON.parse(this.#data.slice(this.#data.position, this.#data.positionAt(1, end))),
					});
					
					this.#data.seek(end);
					this.#data.advance(1);
					
					if (this.#schema[this.#currentKey!].extractArrayItems) {
						this.#state = ParsingState.ExpectingArrayCommaOrEnd;
					} else {
						this.#state = ParsingState.ExpectingTopLevelCommaOrEnd;
						this.#currentKey = null;
					}
					
					if (pushResult === false) {
						this.#canOutputData = false;
						break; // Need to wait until the consumer is ready
					}
					continue;
				}
				
				// Inside a JsonStream.collectEach, after an array item
				if (this.#state === ParsingState.ExpectingArrayCommaOrEnd) {
					if (char !== "," && char !== "]") {
						throw new JsonStreamError(`JSON error: Expected , or ] at position ${this.#debugOffset + this.#data.offset}`);
					}
					
					this.#data.advance(1);
					
					if (char === "]") {
						this.#currentKey = null;
						this.#state = ParsingState.ExpectingTopLevelCommaOrEnd;
					} else {
						this.#state = ParsingState.ExpectingTopLevelData;
					}
					continue;
				}
				
				// After a top-level key/value pair
				if (this.#state === ParsingState.ExpectingTopLevelCommaOrEnd) {
					if (char !== "," && char !== "}") {
						throw new JsonStreamError(`JSON error: Expected , or ] at position ${this.#debugOffset + this.#data.offset}`);
					}
					
					if (char === "}") {
						this.#state = ParsingState.JsonEnded;
						this.#canOutputData = false;
						this.#data.clear();
						break;
					} else {
						this.#data.advance(1);
						this.#state = ParsingState.ExpectingTopLevelKey;
					}
					continue;
				}
			} catch (err) {
				if (this.#getMoreData) {
					const cb = this.#getMoreData;
					this.#getMoreData = null;
					cb(err);
					return;
				}
				this.emit("error", err);
				return;
			}
		}
		
		if (this.#noMoreData) {
			if (this.#state !== ParsingState.JsonEnded) {
				throw new JsonStreamError("JSON interrupted before end");
			}
			
			// Test shouldn't be needed, just for safety
			if (!this.#done) {
				this.#done = true;
				this.push(null);
			}
		}
		
		if (this.#canOutputData && this.#getMoreData) {
			const cb = this.#getMoreData;
			this.#getMoreData = null;
			cb();
		}
	}
}

export namespace JsonStream {
	export class Schema {
		maxSize: number;
		extractArrayItems: boolean;
	}
	
	export function collect(params: { maxChars: number; }): Schema {
		const schema = new Schema();
		schema.maxSize = params.maxChars;
		schema.extractArrayItems = false;
		
		return schema;
	}
	
	export function collectEach(params: { maxItemChars: number; }): Schema {
		const schema = new Schema();
		schema.maxSize = params.maxItemChars;
		schema.extractArrayItems = true;
		
		return schema;
	}
}

interface IntermediateState {
	position: BufferedPosition;
	stringPosition?: BufferedPosition;
	expectCommaOrEnd: boolean;
	stack: Array<"{" | "[">;
}

const JSON_LITERALS = {
	n: "null",
	f: "false",
	t: "true",
} as const;

/**
 * Parse the string to get the start and end of the next JSON value after @param opts.offset
 * 
 * @param opts.intermediateState Avoids parsing from @param opts.offset again, instead use saved state returned by previous call
 * 
 * @return an object with `start` and `end`, which are the start/end of the JSON value or `undefined`. Note:
 * If the start of the JSON value is available but not the end, `start` will be defined and `end` will be `undefined`.
 */
export function getJsonValue(str: BufferedString, opts?: { debugCharOffset?: number; intermediateState?: IntermediateState; }): { end: BufferedPosition | undefined; intermediateState?: IntermediateState; } {
	let current = str.position;
	let intermediateStringPosition = opts?.intermediateState?.stringPosition;
	let stringPositionToReturn: BufferedPosition | undefined;
	
	/**
	 * Represent an array of '[' and '{' for open arrays / objects.
	 */
	const stack: Array<"{" | "["> = opts?.intermediateState?.stack ?? [];
	let expectCommaOrEnd = opts?.intermediateState?.expectCommaOrEnd ?? false;
	
	if (opts?.intermediateState) {
		current = opts.intermediateState.position;
	}
	
	while (1) {
		const index = str.indexOfFirstMatchingChar(REGEX_NON_SPACE, current);
		
		if (!index) {
			break;
		}
		
		current = index;
		
		const char = str.charAt(current);
		if (!expectCommaOrEnd) {
			if (char in JSON_LITERALS) {
				const literal = JSON_LITERALS[char];
				if (str.offsetAt(current) + literal.length > str.size) {
					break; // need more data
				}
				if (str.slice(current, str.positionAt(literal.length, current)) !== literal) {
					throw new JsonStreamError(`Error parsing JSON at position ${(opts?.debugCharOffset ?? 0) + str.offsetAt(current)}, expected "${literal}"`);
				}
				current = str.positionAt(literal.length, current);
				expectCommaOrEnd = true;
			} else if (char === '"') {
				const { end, lastParsedPosition } = getJsonString(str, { offset: current, lastParsedPosition: intermediateStringPosition });
				intermediateStringPosition = undefined;
				if (end === undefined) {
					stringPositionToReturn = lastParsedPosition;
					break; // need more data
				}
				current = str.positionAt(1, end);
				expectCommaOrEnd = true;
			} else if (char === "[") {
				stack.push("[");
				
				if (stack.length > MAX_JSON_DEPTH) {
					throw new JsonStreamError(`JSON parsing supports a maximum of ${MAX_JSON_DEPTH.toLocaleString()} levels deep`);
				}
				
				current = str.positionAt(1, current);
			} else if (char === "{") {
				stack.push("{");
				
				if (stack.length > MAX_JSON_DEPTH) {
					throw new JsonStreamError(`JSON parsing supports a maximum of ${MAX_JSON_DEPTH.toLocaleString()} levels deep`);
				}
				
				current = str.positionAt(1, current);
				
				const quoteStart = str.indexOfFirstMatchingChar(REGEX_NON_SPACE, current);
				
				if (!quoteStart) {
					break;
				}
				
				if (str.charAt(quoteStart) !== '"') {
					throw new JsonStreamError(`JSON error: Expected " at position ${(opts?.debugCharOffset ?? 0) + str.offsetAt(current)}`);
				}
				
				const { end: quoteEnd, lastParsedPosition } = getJsonString(str, { offset: quoteStart, lastParsedPosition: intermediateStringPosition });
				intermediateStringPosition = undefined;
				
				if (quoteEnd === undefined) {
					stringPositionToReturn = lastParsedPosition;
					break; // need more data
				}
				
				const semiColon = str.indexOfFirstMatchingChar(REGEX_NON_SPACE, str.positionAt(1, quoteEnd));
				
				if (!semiColon) {
					// TODO: Maybe save at this position?
					break; // need more data
				}
				
				if (str.charAt(semiColon) !== ":") {
					throw new JsonStreamError(`JSON error: Expected : at position ${(opts?.debugCharOffset ?? 0) + str.offsetAt(current)}`);
				}
				
				current = str.positionAt(1, semiColon);
			} else if (char >= "0" && char <= "9") {
				const end = str.indexOfFirstMatchingChar(REGEX_NON_NUMERICAL_STRING, current);
				
				if (!end) {
					if (str.size - str.offsetAt(current) > MAX_NUMBER_LENGTH) {
						throw new JsonStreamError(`JSON error: Too many characters in number at position ${(opts?.debugCharOffset ?? 0) + str.offsetAt(current)}`);
					}
					break; // need more data
				}
				
				current = end;
				expectCommaOrEnd = true;
			} else {
				throw new JsonStreamError(`Unexpected character in JSON: ${str.charAt(current)} at position ${ (opts?.debugCharOffset ?? 0) + str.offsetAt(current)}`);
			}
		} else {
			if (char === "]") {
				if (stack.pop() !== "[") {
					throw new JsonStreamError(`Unexpected character in JSON: ${str.charAt(current)} at position ${ (opts?.debugCharOffset ?? 0) + str.offsetAt(current)}`);
				}
				current = str.positionAt(1, current);
				expectCommaOrEnd = true;
			} else if (char === "}") {
				if (stack.pop() !== "{") {
					throw new JsonStreamError(`Unexpected character in JSON: ${str.charAt(current)} at position ${ (opts?.debugCharOffset ?? 0) + str.offsetAt(current)}`);
				}
				current = str.positionAt(1, current);
				expectCommaOrEnd = true;
			} else if (char === ",") {
				current = str.positionAt(1, current);
				
				if (stack[stack.length - 1] === "{") {
					// Copy of similar code above - to parse object key + semi-colon
					const quoteStart = str.indexOfFirstMatchingChar(REGEX_NON_SPACE, current);
				
					if (!quoteStart) {
						break;
					}
				
					if (str.charAt(quoteStart) !== '"') {
						throw new JsonStreamError(`JSON error: Expected " at position ${(opts?.debugCharOffset ?? 0) + str.offsetAt(current)}`);
					}
				
					const { end: quoteEnd, lastParsedPosition } = getJsonString(str, { offset: quoteStart, lastParsedPosition: intermediateStringPosition });
					intermediateStringPosition = undefined;
				
					if (quoteEnd === undefined) {
						stringPositionToReturn = lastParsedPosition;
						break; // need more data
					}
				
					const semiColon = str.indexOfFirstMatchingChar(REGEX_NON_SPACE, str.positionAt(1, quoteEnd));
				
					if (!semiColon) {
					// TODO: Maybe save at this position?
						break; // need more data
					}
				
					if (str.charAt(semiColon) !== ":") {
						throw new JsonStreamError(`JSON error: Expected : at position ${(opts?.debugCharOffset ?? 0) + str.offsetAt(current)}`);
					}
				
					current = str.positionAt(1, semiColon);
				}
				expectCommaOrEnd = false;
			} else {
				throw new JsonStreamError(`Unexpected character in JSON: ${str.charAt(current)} at position ${ (opts?.debugCharOffset ?? 0) + str.offsetAt(current)}`);
			}
		}
		
		if (expectCommaOrEnd && stack.length === 0) {
			return {
				end: str.positionAt(-1, current),
			};
		}
	}
	
	const intermediateState: IntermediateState = {
		position:       current,
		expectCommaOrEnd,
		stack,
		stringPosition: stringPositionToReturn,
	};
	
	return { end: undefined, intermediateState };
}

/**
 * Parse the string to get the end of the JSON string
 */
export function getJsonString(str: BufferedString, opts?: { offset?: BufferedPosition; lastParsedPosition?: BufferedPosition; }): { end?: BufferedPosition; lastParsedPosition?: BufferedPosition; } {
	if (str.charAt(opts?.offset ?? str.position) !== '"') {
		throw new TypeError("str must start with a double-quote, found: " + str.firstChar);
	}

	let nextChar = opts?.lastParsedPosition ?? str.positionAt(1, opts?.offset);
	
	while (1) {
		const nextPos = str.indexOfFirstMatchingChar(REGEX_ANTISLASH_OR_END_QUOTE, nextChar);
		if (!nextPos) {
			return { lastParsedPosition: str.end };
		}
		nextChar = nextPos;
		
		if (str.charAt(nextChar) === '"') {
			return { end: nextChar };
		}
		
		// str[nextChar] === "\\", skip the current + next character
		if (! BufferedPosition.equals(str.last, nextChar)) {
			nextChar = str.positionAt(2, nextChar);
		}
	}
	
	throw new Error("unreachable code");
}
