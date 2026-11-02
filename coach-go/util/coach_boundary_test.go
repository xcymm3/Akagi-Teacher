package util
import ("math"; "testing")
func TestCoachEqualSpeedRates(t *testing.T){
 r:=&Hand13AnalysisResult{Waits:Waits{0:8},AvgNextShantenWaitsCount:8,LeftTiles34:make([]int,34)}
 for i:=range r.LeftTiles34{r.LeftTiles34[i]=4}
 v:=r.speedScore();if math.IsNaN(v)||math.IsInf(v,0)||v<=0||v>100{t.Fatalf("invalid speed %v",v)}
 r.AvgNextShantenWaitsCount=8.00001
 if math.Abs(v-r.speedScore())>0.001{t.Fatal("discontinuous speed boundary")}
}
