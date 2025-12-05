"""
Test script for the new /analyze-issue endpoint
Run this after starting the AI service to verify it's working correctly
"""
import requests
import json

# API endpoint
API_URL = "http://localhost:8000/analyze-issue"

# Test cases
test_cases = [
    {
        "name": "Electricity Outage",
        "description": "It has been over a week now we have not had electricity in our community."
    },
    {
        "name": "Water Shortage",
        "description": "No water supply for 3 days. The taps are completely dry and we need water urgently."
    },
    {
        "name": "Road Damage",
        "description": "There is a massive pothole on Main Street that has damaged several cars already."
    },
    {
        "name": "Waste Management",
        "description": "Garbage has not been collected for two weeks and it's piling up everywhere."
    },
    {
        "name": "Critical Health Issue",
        "description": "The clinic has run out of essential medicines and people are suffering."
    },
    {
        "name": "Minor Issue",
        "description": "A streetlight near my house is flickering."
    }
]

print("=" * 80)
print("Testing /analyze-issue endpoint")
print("=" * 80)

for i, test in enumerate(test_cases, 1):
    print(f"\n[Test {i}/{len(test_cases)}] {test['name']}")
    print(f"Description: {test['description']}")
    print("-" * 80)
    
    try:
        response = requests.post(
            API_URL,
            json={"description": test['description']},
            timeout=30
        )
        
        if response.status_code == 200:
            result = response.json()
            print(f"✅ SUCCESS")
            print(f"   Summary:  {result.get('summary', 'N/A')}")
            print(f"   Category: {result.get('category', 'N/A')}")
            print(f"   Urgency:  {result.get('urgency', 'N/A')}")
        else:
            print(f"❌ FAILED - Status Code: {response.status_code}")
            print(f"   Response: {response.text}")
    
    except requests.exceptions.Timeout:
        print(f"❌ TIMEOUT - Request took longer than 30 seconds")
    except requests.exceptions.ConnectionError:
        print(f"❌ CONNECTION ERROR - Is the AI service running on port 8000?")
    except Exception as e:
        print(f"❌ ERROR - {str(e)}")

print("\n" + "=" * 80)
print("Testing complete!")
print("=" * 80)
