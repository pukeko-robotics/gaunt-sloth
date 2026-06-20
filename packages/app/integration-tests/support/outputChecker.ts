/**
 * Checks if the output contains the expected content (case-insensitive)
 * @param output - The output to check
 * @param expectedContent - The content to look for (string or array of strings)
 * @returns True if the output contains the expected content (or any string from the array), false otherwise
 */
export function checkOutputForExpectedContent(
  output: string,
  expectedContent: string | string[]
): boolean {
  // Convert output to lowercase for case-insensitive comparison
  const lowerOutput = output.toLowerCase();

  // If expectedContent is an array, check if output contains any of the strings
  if (Array.isArray(expectedContent)) {
    return expectedContent.some((content) => lowerOutput.includes(content.toLowerCase()));
  }

  // If expectedContent is a string, check if output contains it
  const lowerExpected = expectedContent.toLowerCase();
  return lowerOutput.includes(lowerExpected);
}
