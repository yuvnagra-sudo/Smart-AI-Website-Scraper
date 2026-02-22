#!/usr/bin/env python3
"""
Quality Audit Script for VC Enrichment Data
Analyzes the Excel output and selects random samples for manual verification
"""

import pandas as pd
import random
import json

# Load the Excel file
excel_file = "/home/ubuntu/vc-enrichment-web/audit-data.xlsx"

# Read all sheets
print("=" * 60)
print("VC ENRICHMENT DATA QUALITY AUDIT")
print("=" * 60)

# Load sheets
firms_df = pd.read_excel(excel_file, sheet_name="VC Firms")
members_df = pd.read_excel(excel_file, sheet_name="Team Members")

# Check if Portfolio Companies sheet exists
try:
    portfolio_df = pd.read_excel(excel_file, sheet_name="Portfolio Companies")
    has_portfolio = True
except:
    portfolio_df = pd.DataFrame()
    has_portfolio = False

# Check if Extraction Metrics sheet exists
try:
    metrics_df = pd.read_excel(excel_file, sheet_name="Extraction Metrics")
    has_metrics = True
except:
    metrics_df = pd.DataFrame()
    has_metrics = False

print(f"\n📊 DATA OVERVIEW")
print("-" * 40)
print(f"Total VC Firms: {len(firms_df)}")
print(f"Total Team Members: {len(members_df)}")
if has_portfolio:
    print(f"Total Portfolio Companies: {len(portfolio_df)}")
if has_metrics:
    print(f"Extraction Metrics Available: Yes")

# Analyze firms data
print(f"\n📋 FIRMS DATA COLUMNS:")
print(firms_df.columns.tolist())

print(f"\n👥 TEAM MEMBERS DATA COLUMNS:")
print(members_df.columns.tolist())

# Data quality metrics
print(f"\n📈 DATA QUALITY METRICS")
print("-" * 40)

# Team members per firm
members_per_firm = members_df.groupby('vcFirm').size()
print(f"Avg team members per firm: {members_per_firm.mean():.1f}")
print(f"Min team members: {members_per_firm.min()}")
print(f"Max team members: {members_per_firm.max()}")

# LinkedIn coverage
linkedin_filled = members_df['linkedinUrl'].notna() & (members_df['linkedinUrl'] != '')
print(f"\nLinkedIn URL coverage: {linkedin_filled.sum()}/{len(members_df)} ({100*linkedin_filled.sum()/len(members_df):.1f}%)")

# Email coverage
email_filled = members_df['email'].notna() & (members_df['email'] != '')
print(f"Email coverage: {email_filled.sum()}/{len(members_df)} ({100*email_filled.sum()/len(members_df):.1f}%)")

# Portfolio companies coverage (if column exists)
if 'portfolioCompanies' in members_df.columns:
    portfolio_filled = members_df['portfolioCompanies'].notna() & (members_df['portfolioCompanies'] != '')
    print(f"Portfolio Companies coverage: {portfolio_filled.sum()}/{len(members_df)} ({100*portfolio_filled.sum()/len(members_df):.1f}%)")

# Title coverage
title_filled = members_df['title'].notna() & (members_df['title'] != '')
print(f"Title coverage: {title_filled.sum()}/{len(members_df)} ({100*title_filled.sum()/len(members_df):.1f}%)")

# Tier distribution
if 'decisionMakerTier' in members_df.columns:
    print(f"\n📊 TIER DISTRIBUTION:")
    tier_counts = members_df['decisionMakerTier'].value_counts()
    for tier, count in tier_counts.items():
        print(f"  {tier}: {count} ({100*count/len(members_df):.1f}%)")

# Select random sample of 5 firms for detailed audit
print(f"\n🎲 RANDOM SAMPLE FOR AUDIT")
print("-" * 40)

# Get unique firms
unique_firms = firms_df['companyName'].unique().tolist()
print(f"Total unique firms: {len(unique_firms)}")

# Select 5 random firms
random.seed(42)  # For reproducibility
sample_firms = random.sample(unique_firms, min(5, len(unique_firms)))

print(f"\nSelected firms for audit:")
for i, firm in enumerate(sample_firms, 1):
    firm_data = firms_df[firms_df['companyName'] == firm].iloc[0]
    firm_members = members_df[members_df['vcFirm'] == firm]
    print(f"\n{i}. {firm}")
    print(f"   Website: {firm_data.get('websiteUrl', 'N/A')}")
    print(f"   Team members extracted: {len(firm_members)}")
    
    # Show sample team members
    print(f"   Sample team members:")
    for _, member in firm_members.head(5).iterrows():
        email_status = "✓" if member.get('email') and str(member.get('email')).strip() else "✗"
        linkedin_status = "✓" if member.get('linkedinUrl') and str(member.get('linkedinUrl')).strip() else "✗"
        portfolio_status = "✓" if member.get('portfolioCompanies') and str(member.get('portfolioCompanies')).strip() else "✗"
        print(f"     - {member['name']} | {member.get('title', 'N/A')} | Email:{email_status} LinkedIn:{linkedin_status} Portfolio:{portfolio_status}")

# Save sample data for detailed comparison
sample_data = []
for firm in sample_firms:
    firm_data = firms_df[firms_df['companyName'] == firm].iloc[0].to_dict()
    firm_members = members_df[members_df['vcFirm'] == firm].to_dict('records')
    sample_data.append({
        'firm': firm,
        'website': firm_data.get('websiteUrl', ''),
        'firm_data': firm_data,
        'team_members': firm_members
    })

with open('/home/ubuntu/vc-enrichment-web/audit_sample.json', 'w') as f:
    json.dump(sample_data, f, indent=2, default=str)

print(f"\n✅ Sample data saved to audit_sample.json")
print(f"\nNext step: Visit each firm's website to verify data accuracy")
