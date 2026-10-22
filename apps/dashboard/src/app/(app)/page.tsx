'use client'
import { AllBrandsScreen } from '../../screens/AllBrands'

// Home for someone outside any one brand: the platform owner sees every brand with its figures; a member of
// exactly one brand goes straight to that brand's Home.
export default function Front() {
  return <AllBrandsScreen single />
}
