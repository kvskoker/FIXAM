"""
Test script for AI Service endpoints
Tests the /transcribe, /classify-image, /analyze, and /classify endpoints
"""

import requests
import sys

BASE_URL = "http://localhost:8000"

def test_service_health():
    """Test if the service is running"""
    try:
        response = requests.get(f"{BASE_URL}/docs")
        if response.status_code == 200:
            print("✅ Service is running!")
            return True
        else:
            print(f"❌ Service returned status code: {response.status_code}")
            return False
    except requests.exceptions.ConnectionError:
        print("❌ Cannot connect to service. Is it running on port 8000?")
        return False
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

def test_analyze_endpoint():
    """Test the /analyze endpoint"""
    print("\n📝 Testing /analyze endpoint...")
    try:
        response = requests.post(
            f"{BASE_URL}/analyze",
            json={"input_text": "This is a test message about a broken streetlight"}
        )
        if response.status_code == 200:
            data = response.json()
            if "embedding" in data and len(data["embedding"]) > 0:
                print(f"✅ /analyze endpoint working! Embedding dimension: {len(data['embedding'])}")
                return True
            else:
                print("❌ /analyze returned invalid response")
                return False
        else:
            print(f"❌ /analyze failed with status {response.status_code}: {response.text}")
            return False
    except Exception as e:
        print(f"❌ Error testing /analyze: {e}")
        return False

def test_classify_endpoint():
    """Test the /classify endpoint"""
    print("\n🏷️  Testing /classify endpoint...")
    try:
        response = requests.post(
            f"{BASE_URL}/classify",
            json={
                "text": "The streetlight on Main Street is broken and needs repair",
                "candidate_labels": [
                    "Infrastructure (Roads, Bridges, Streetlights)",
                    "Waste Management",
                    "Public Safety",
                    "Water and Sanitation"
                ]
            }
        )
        if response.status_code == 200:
            data = response.json()
            if "best_label" in data and "score" in data:
                print(f"✅ /classify endpoint working!")
                print(f"   Best match: {data['best_label']}")
                print(f"   Confidence: {data['score']:.4f}")
                return True
            else:
                print("❌ /classify returned invalid response")
                return False
        else:
            print(f"❌ /classify failed with status {response.status_code}: {response.text}")
            return False
    except Exception as e:
        print(f"❌ Error testing /classify: {e}")
        return False

def main():
    print("=" * 60)
    print("AI Service Test Suite")
    print("=" * 60)
    
    results = []
    
    # Test 1: Service health
    results.append(("Service Health", test_service_health()))
    
    if not results[0][1]:
        print("\n❌ Service is not running. Please start it first.")
        sys.exit(1)
    
    # Test 2: Analyze endpoint
    results.append(("Analyze Endpoint", test_analyze_endpoint()))
    
    # Test 3: Classify endpoint
    results.append(("Classify Endpoint", test_classify_endpoint()))
    
    # Summary
    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for test_name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status}: {test_name}")
    
    print(f"\nTotal: {passed}/{total} tests passed")
    
    if passed == total:
        print("\n🎉 All tests passed!")
        sys.exit(0)
    else:
        print(f"\n⚠️  {total - passed} test(s) failed")
        sys.exit(1)

if __name__ == "__main__":
    main()
