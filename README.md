# AI-Powered VC Prospect Research & Enrichment Tool

**Author:** Manus AI
**Version:** 1.0.0
**Date:** 2025-11-27

## Overview

This project provides an AI-powered workflow for enriching venture capital (VC) firm data. It is designed for professionals in cold outreach, M&A deal sourcing, and client acquisition for services like accounting. The tool takes a simple list of VC firms (company name, website URL, and description) and automatically enriches it with detailed information about their investment niches, team members, and recent portfolio companies.

This solution is built to be both powerful and flexible, leveraging web scraping and AI-powered analysis to deliver high-quality, actionable data. It includes features for data verification, cross-referencing, and confidence scoring to ensure accuracy.

## Features

- **Automated Data Enrichment:** Enriches a list of VC firms with minimal manual effort.
- **Comprehensive Data Extraction:** Extracts VC firm investment niches, team member details (including LinkedIn URLs), and recent portfolio companies.
- **AI-Powered Analysis:** Uses large language models (LLMs) to analyze website content, verify information, and categorize data based on a predefined taxonomy.
- **Data Verification & Confidence Scoring:** Cross-references information and provides confidence scores (High, Medium, Low) to help you gauge data accuracy.
- **Browser Automation:** Includes an enhanced mode that uses browser automation to handle modern, JavaScript-heavy websites for more reliable data extraction.
- **Customizable Niche Taxonomy:** The investment niche taxonomy can be easily customized to fit your specific needs.
- **Excel Export:** Exports the enriched data into a well-structured Excel file with separate sheets for VC firms, team members, and portfolio companies.

## How It Works

The enrichment process follows these steps for each VC firm in the input file:

1.  **Website Verification:** The tool first visits the provided website URL and uses AI to confirm that it belongs to the specified company.
2.  **Investment Niche Extraction:** It then scrapes the website to find the firm's investment focus and maps it to a predefined list of investment niches.
3.  **Team Member Extraction:** The tool navigates to the "Team" or "About" page to extract team member names, titles, and LinkedIn URLs.
4.  **Portfolio Company Extraction:** It identifies the firm's portfolio page and extracts the last five investments, including their names and websites.
5.  **Portfolio Company Analysis:** For each portfolio company, the tool visits their website to deduce their investment niche.
6.  **Data Export:** All the enriched data is compiled and saved to a new Excel file.

## Technology Stack

- **Python 3.11:** Core programming language.
- **Pandas:** For data manipulation and Excel file handling.
- **OpenAI API:** For AI-powered analysis and data extraction.
- **BeautifulSoup4 & Requests:** For basic web scraping.
- **Playwright (Optional):** For advanced web scraping with browser automation.
- **OpenPyXL:** For writing to Excel files.

## Setup and Installation

1.  **Clone the repository:**

    ```bash
    git clone <repository_url>
    cd vc-enrichment-workflow
    ```

2.  **Install Python dependencies:**

    ```bash
    pip install -r requirements.txt
    ```

3.  **Install Playwright browsers (for enhanced mode):**

    ```bash
    playwright install
    ```

4.  **Set up your OpenAI API key:**

    Make sure you have your OpenAI API key set as an environment variable:

    ```bash
    export OPENAI_API_KEY=\'your_api_key_here\'
    ```

## Usage

1.  **Prepare your input file:**

    Create an Excel file (e.g., `input.xlsx`) with the following columns:

    -   `Company Name`
    -   `Company Website URL`
    -   `LinkedIn Description`

    A sample input file (`sample_vc_input.xlsx`) is provided for reference.

2.  **Run the enrichment tool:**

    You can run the tool in two modes:

    **Standard Mode (Basic Web Scraping):**

    ```bash
    python vc_enrichment_enhanced.py input.xlsx output.xlsx
    ```

    **Enhanced Mode (with Browser Automation):**

    For better results on modern websites, use the `--browser` flag:

    ```bash
    python vc_enrichment_enhanced.py input.xlsx output.xlsx --browser
    ```

    The tool will process each VC firm and save the results to the specified output file (e.g., `output.xlsx`).

## Output Structure

The output Excel file will contain three sheets:

1.  **VC Firms:** An overview of each VC firm, including their verified website, investment niches, and confidence scores.
2.  **Team Members:** A detailed list of team members, including their titles, job functions, LinkedIn URLs, and specializations.
3.  **Portfolio Companies:** A list of the last five portfolio companies, including their investment dates, websites, and deduced investment niches.

## Customization

### Investment Niche Taxonomy

You can customize the investment niche taxonomy by editing the `niche_taxonomy.py` file. The `INVESTMENT_NICHES` dictionary defines the categories and sub-niches used for classification. You can add, remove, or modify these to fit your needs.

### AI Model

By default, the tool uses the `gpt-4.1-mini` model. You can change this by modifying the `model` parameter in the `VCEnrichmentToolEnhanced` class initialization in `vc_enrichment_enhanced.py`.

## Future Enhancements

-   **Integration with APIs:** Integrate with LinkedIn and Crunchbase APIs for even more accurate and comprehensive data.
-   **Automated Re-enrichment:** Add a feature to periodically re-enrich the data to keep it up-to-date.
-   **Machine Learning Model:** Train a custom machine learning model to improve the accuracy of niche categorization over time.

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.
