import { describe, expect, it } from "vitest";
import { cleanTweetText } from "../src/text.js";

describe("tweet cleanup", () => {
  it("cleans copied break tags, entities and whitespace", () => {
    expect(cleanTweetText("Great news.&nbsp;\\<br/\\>  Reset &amp; enjoy!"))
      .toBe("Great news. Reset & enjoy!");
  });
});
