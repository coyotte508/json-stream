There are several existing JSON streaming modules but they do not add size limits for individual items. And they do not allow the level of control that providing a schema does.

We also use fully modern javascript/Typescript, including `await` / `async`.

This implementation can limit the number of characters for every value we're interested in, and can limit the number of bytes for the overall payload. An improvement would be a control over the number of bytes for the individual values,
as characters can be 4 bytes in UTF-8.

## Sample code

```ts
import { Readable } from "stream";
import { pipeline } from "stream/promises";

// Define the schema
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

// Convert the string payload into a stream
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
```

## Alternatives

Using a format like [JSON lines](https://jsonlines.org/) is probably much simpler, if you have control over the sender.
