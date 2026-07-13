/**
 * CSV Parser Service
 *
 * Handles CSV file parsing with progress tracking, error handling,
 * and validation for TradeBlocks data.
 */

import type { ParsingError } from "../models/index.ts";
// import { ProcessingError } from '../models/index.ts'

/**
 * CSV parsing configuration
 */
export interface CSVParseConfig {
  delimiter?: string;
  quote?: string;
  escape?: string;
  skipEmptyLines?: boolean;
  trimValues?: boolean;
  maxRows?: number;
  progressCallback?: (progress: number, rowsProcessed: number) => void;
}

/**
 * CSV parsing result
 */
export interface CSVParseResult<T = Record<string, string>> {
  data: T[];
  headers: string[];
  totalRows: number;
  validRows: number;
  errors: ParsingError[];
  warnings: string[];
}

/**
 * CSV parsing progress info
 */
export interface ParseProgress {
  stage: "reading" | "parsing" | "validating" | "converting" | "completed";
  progress: number; // 0-100
  rowsProcessed: number;
  totalRows: number;
  errors: number;
}

/**
 * Base CSV parser class with streaming support for large files
 */
export class CSVParser {
  private config: Required<CSVParseConfig>;

  constructor(config: CSVParseConfig = {}) {
    this.config = {
      delimiter: ",",
      quote: '"',
      escape: '"',
      skipEmptyLines: true,
      trimValues: true,
      maxRows: 100000, // Safety limit
      progressCallback: () => {},
      ...config,
    };
  }

  /**
   * Parse CSV file content
   */
  async parseFile<T = Record<string, string>>(
    fileContent: string,
    validator?: (row: Record<string, string>, rowIndex: number) => T | null,
  ): Promise<CSVParseResult<T>> {
    const errors: ParsingError[] = [];
    const warnings: string[] = [];
    const data: T[] = [];

    try {
      // Split into lines and handle different line endings
      const lines = fileContent.split(/\r?\n/);
      const totalRows = lines.length;

      if (totalRows === 0) {
        throw new Error("Empty CSV file");
      }

      // Parse headers
      const headerLine = lines[0];
      if (!headerLine || headerLine.trim() === "") {
        throw new Error("Missing CSV headers");
      }

      const headers = this.parseLine(headerLine);
      if (headers.length === 0) {
        throw new Error("No valid headers found");
      }

      // Clean headers (remove BOM, trim whitespace)
      const cleanHeaders = headers.map((header) => header.replace(/^\ufeff/, "").trim());

      let validRows = 0;
      let processedRows = 0;

      // Process data rows
      for (let i = 1; i < lines.length && processedRows < this.config.maxRows; i++) {
        const line = lines[i];

        // Skip empty lines if configured
        if (this.config.skipEmptyLines && (!line || line.trim() === "")) {
          continue;
        }

        processedRows++;

        try {
          const values = this.parseLine(line);

          // Create row object
          const row: Record<string, string> = {};
          cleanHeaders.forEach((header, index) => {
            const value = values[index] || "";
            row[header] = this.config.trimValues ? value.trim() : value;
          });

          // Validate row if validator provided
          if (validator) {
            const validatedRow = validator(row, i);
            if (validatedRow) {
              data.push(validatedRow);
              validRows++;
            }
          } else {
            data.push(row as T);
            validRows++;
          }
        } catch (error) {
          const parsingError: ParsingError = {
            type: "parsing",
            message: `Error parsing line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
            details: { lineNumber: i + 1, line },
            line: i + 1,
            raw: line,
          };
          errors.push(parsingError);
        }

        // Report progress
        if (processedRows % 100 === 0 || processedRows === totalRows - 1) {
          const progress = Math.round((processedRows / (totalRows - 1)) * 100);
          this.config.progressCallback(progress, processedRows);
        }
      }

      // Check for truncation
      if (processedRows >= this.config.maxRows && lines.length > this.config.maxRows + 1) {
        warnings.push(`File truncated at ${this.config.maxRows} rows for performance`);
      }

      return {
        data,
        headers: cleanHeaders,
        // Count data records actually encountered. Physical line count includes
        // trailing blank lines, which are not CSV records when skipEmptyLines is on.
        totalRows: processedRows,
        validRows,
        errors,
        warnings,
      };
    } catch (error) {
      const parsingError: ParsingError = {
        type: "parsing",
        message: `CSV parsing failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { fileContent: fileContent.substring(0, 500) + "..." },
        line: 0,
        raw: "",
      };

      return {
        data: [],
        headers: [],
        totalRows: 0,
        validRows: 0,
        errors: [parsingError],
        warnings,
      };
    }
  }

  /**
   * Parse CSV from File object with progress tracking
   */
  async parseFileObject<T = Record<string, string>>(
    file: File,
    validator?: (row: Record<string, string>, rowIndex: number) => T | null,
    progressCallback?: (progress: ParseProgress) => void,
  ): Promise<CSVParseResult<T>> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onprogress = (event) => {
        if (event.lengthComputable && progressCallback) {
          const progress = Math.round((event.loaded / event.total) * 100);
          progressCallback({
            stage: "reading",
            progress,
            rowsProcessed: 0,
            totalRows: 0,
            errors: 0,
          });
        }
      };

      reader.onload = async (event) => {
        try {
          const content = event.target?.result as string;
          if (!content) {
            throw new Error("Failed to read file content");
          }

          // Update progress callback for parsing stage
          const parseConfig = {
            ...this.config,
            progressCallback: (progress: number, rowsProcessed: number) => {
              if (progressCallback) {
                progressCallback({
                  stage: "parsing",
                  progress,
                  rowsProcessed,
                  totalRows: content.split(/\r?\n/).length - 1,
                  errors: 0,
                });
              }
            },
          };

          const parser = new CSVParser(parseConfig);
          const result = await parser.parseFile(content, validator);

          if (progressCallback) {
            progressCallback({
              stage: "completed",
              progress: 100,
              rowsProcessed: result.validRows,
              totalRows: result.totalRows,
              errors: result.errors.length,
            });
          }

          resolve(result);
        } catch (error) {
          reject(error);
        }
      };

      reader.onerror = () => {
        reject(new Error("Failed to read file"));
      };

      reader.readAsText(file);
    });
  }

  /**
   * Parse a single CSV line, handling quoted values and escapes
   */
  private parseLine(line: string): string[] {
    const result: string[] = [];
    const { delimiter, quote, escape } = this.config;

    let current = "";
    let inQuotes = false;
    let i = 0;

    while (i < line.length) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (!inQuotes) {
        if (char === delimiter) {
          result.push(current);
          current = "";
        } else if (char === quote) {
          inQuotes = true;
        } else {
          current += char;
        }
      } else {
        if (char === escape && nextChar === quote) {
          // Escaped quote
          current += quote;
          i++; // Skip next character
        } else if (char === quote) {
          inQuotes = false;
        } else {
          current += char;
        }
      }

      i++;
    }

    // Add the last field
    result.push(current);

    return result;
  }

  /**
   * Validate CSV file format before parsing
   */
  static validateCSVFile(file: File): { valid: boolean; error?: string } {
    // Check file type
    const validTypes = ["text/csv", "application/vnd.ms-excel", "text/plain"];
    if (!validTypes.includes(file.type) && !file.name.toLowerCase().endsWith(".csv")) {
      return { valid: false, error: "File must be a CSV file (.csv extension)" };
    }

    // Check file size (50MB limit)
    const maxSize = 50 * 1024 * 1024;
    if (file.size > maxSize) {
      return { valid: false, error: "File size must be less than 50MB" };
    }

    // Check for empty file
    if (file.size === 0) {
      return { valid: false, error: "File is empty" };
    }

    return { valid: true };
  }

  /**
   * Detect CSV delimiter from sample content
   */
  static detectDelimiter(sampleContent: string): string {
    const delimiters = [",", ";", "\t", "|"];
    const lines = sampleContent.split(/\r?\n/).slice(0, 5); // Check first 5 lines

    let bestDelimiter = ",";
    let maxScore = 0;

    for (const delimiter of delimiters) {
      let score = 0;
      let consistentCounts = true;
      let expectedCount = -1;

      for (const line of lines) {
        if (!line.trim()) continue;

        const count = line.split(delimiter).length - 1;
        if (expectedCount === -1) {
          expectedCount = count;
        } else if (count !== expectedCount) {
          consistentCounts = false;
          break;
        }
        score += count;
      }

      if (consistentCounts && score > maxScore) {
        maxScore = score;
        bestDelimiter = delimiter;
      }
    }

    return bestDelimiter;
  }
}
