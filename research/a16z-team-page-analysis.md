# Andreessen Horowitz Team Page Analysis

## URL
https://a16z.com/team/

## Key Findings

### Page Structure
- **Hundreds of team members** listed with names and roles
- Each member has: Name + Department (e.g., "Abby Green - Marketing", "Alex Rampell - Investing")
- Team members are displayed as cards with photos
- Filterable by department (American Dynamism, Bio + Health, Consumer, Crypto, etc.)

### Investing Team Members Found (Sample)
- **Alex Immerman** - Investing
- **Alex Rampell** - Investing  
- **Ali Yahya** - Investing
- **Andrew Chen** - Investing
- **Andy McCall** - Investing
- **Angela Strange** - Investing
- **Anish Acharya** - Investing
- **Anjney Midha** - Investing
- **Arianna Simpson** - Investing
- **Ben Horowitz** - Investing (Co-founder)
- **Ben Portney** - Investing
- **Brian Roberts** - Investing
- **Bryan Faust** - Investing
- **Bryan Kim** - Investing
- **Caroline Goggins** - Investing
- **Chris Dixon** - Investing
- **Chris Lyons** - Investing
- **Connie Chan** - Investing
- **Daisy Wolf** - Investing
- **Daniel Penny** - Investing
- **Daren Matsuoka** - Investing
- **David George** - Investing
- **David Haber** - Investing
- **David Ulevitch** - Investing
- **Eddy Lazzarin** - Investing
- **Elizabeth Harkavy** - Investing
- **Emily Bennett** - Investing
- **Emma Cooper** - Investing
- **Eric Alby** - Investing
- **Eric Zhou** - Investing
- **Erik Torenberg** - Marketing, Investing
- **Erin Price-Wright** - Investing
- **Eva Steinman** - Investing
- **Gabriel Vasquez** - Investing
- **Gio Ahern** - Investing
- **Guido Appenzeller** - Investing
- **Guy Wuollet** - Investing
- **Jacob Zietek** - Investing
- **James da Costa** - Investing
- **Jamie Sullivan** - Investing
- **Jane Rhee** - Investing
- **Jason Cui** - Investing
- **Jay Drain** - Investing
- **Jay Rughani** - Investing

### Issues with Current Scraper
1. **Format**: Names and titles are in simple text format: `[Name]() Department`
2. **No explicit job titles**: Only department names (Investing, Marketing, Operations, etc.)
3. **No LinkedIn URLs**: The page doesn't include LinkedIn links
4. **JavaScript rendering**: Team member cards are likely loaded dynamically

### Why Scraper is Failing
- LLM is extracting "Investing" as the title instead of inferring actual roles (Partner, Principal, etc.)
- "Investing" doesn't match any tier patterns → classified as "Exclude"
- All investing team members get filtered out despite being the exact people we want

### Solution Needed
- Recognize "Investing" department as deal sourcing role
- Infer likely titles based on seniority/context
- Or: Include anyone in "Investing" department regardless of explicit title
