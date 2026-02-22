import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseInputExcel } from "./excelProcessor";
import { storagePut } from "./storage";
import { nanoid } from "nanoid";

describe("Excel column parsing", () => {
  it("should parse Excel with standard column names", async () => {
    // Create a test Excel file
    const data = [
      {
        "Company Name": "Test VC",
        "Company Website URL": "https://test.vc",
        "LinkedIn Description": "A test VC firm",
      },
    ];

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    // Upload to S3
    const fileKey = `test/${nanoid()}.xlsx`;
    const { url } = await storagePut(fileKey, buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    // Parse
    const firms = await parseInputExcel(url);

    expect(firms).toHaveLength(1);
    expect(firms[0]?.companyName).toBe("Test VC");
    expect(firms[0]?.websiteUrl).toBe("https://test.vc");
    expect(firms[0]?.description).toBe("A test VC firm");
  });

  it("should parse Excel with lowercase column names", async () => {
    const data = [
      {
        "name": "Test VC 2",
        "website": "https://test2.vc",
        "description": "Another test VC",
      },
    ];

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const fileKey = `test/${nanoid()}.xlsx`;
    const { url } = await storagePut(fileKey, buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const firms = await parseInputExcel(url);

    expect(firms).toHaveLength(1);
    expect(firms[0]?.companyName).toBe("Test VC 2");
  });

  it("should parse Excel with alternative column names", async () => {
    const data = [
      {
        "Firm Name": "Test VC 3",
        "URL": "https://test3.vc",
        "About": "Yet another test VC",
      },
    ];

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const fileKey = `test/${nanoid()}.xlsx`;
    const { url } = await storagePut(fileKey, buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const firms = await parseInputExcel(url);

    expect(firms).toHaveLength(1);
    expect(firms[0]?.companyName).toBe("Test VC 3");
    expect(firms[0]?.websiteUrl).toBe("https://test3.vc");
    expect(firms[0]?.description).toBe("Yet another test VC");
  });

  it("should parse Excel with LinkedIn export column names", async () => {
    const data = [
      {
        "company": "LinkedIn VC",
        "corporate website": "https://linkedin-vc.com",
        "description": "A VC firm from LinkedIn export",
      },
    ];

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const fileKey = `test/${nanoid()}.xlsx`;
    const { url } = await storagePut(fileKey, buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const firms = await parseInputExcel(url);

    expect(firms).toHaveLength(1);
    expect(firms[0]?.companyName).toBe("LinkedIn VC");
    expect(firms[0]?.websiteUrl).toBe("https://linkedin-vc.com");
    expect(firms[0]?.description).toBe("A VC firm from LinkedIn export");
  });

  it("should provide helpful error message for wrong columns", async () => {
    const data = [
      {
        "Wrong Column 1": "Test",
        "Wrong Column 2": "Test",
      },
    ];

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    const fileKey = `test/${nanoid()}.xlsx`;
    const { url } = await storagePut(fileKey, buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    await expect(parseInputExcel(url)).rejects.toThrow(/Your Excel file has columns/);
  });
});
