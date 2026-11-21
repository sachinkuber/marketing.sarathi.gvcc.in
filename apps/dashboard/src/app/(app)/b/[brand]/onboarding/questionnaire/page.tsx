'use client'
import { useParams } from 'next/navigation'
import { QuestionnaireScreen } from '../../../../../../screens/Questionnaire'

export default function QuestionnairePage() {
  const { brand } = useParams<{ brand: string }>()
  return <QuestionnaireScreen brandId={brand} />
}
