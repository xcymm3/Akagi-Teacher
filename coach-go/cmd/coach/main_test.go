package main

import (
	"encoding/json"
	"github.com/EndlessCheng/mahjong-helper/util"
	"os"
	"reflect"
	"testing"
)

func fixture(t *testing.T) Input {
	t.Helper()
	b, e := os.ReadFile("../../fixture.json")
	if e != nil {
		t.Fatal(e)
	}
	var in Input
	if e = json.Unmarshal(b, &in); e != nil {
		t.Fatal(e)
	}
	return in
}
func TestAdapterParityAndImmutability(t *testing.T) {
	in := fixture(t)
	before, _ := json.Marshal(in)
	got := analyze(in)
	after, _ := json.Marshal(in)
	if string(before) != string(after) {
		t.Fatal("mutated input snapshot")
	}
	pi := player(in.Snapshot, 0, in.Left)
	pi.DiscardTile(17, false)
	want := metrics(util.CalculateShantenWithImproves13(pi))
	if !reflect.DeepEqual(got.Candidates[0], &want) {
		t.Fatalf("upstream parity mismatch: %+v vs %+v", got.Candidates[0], want)
	}
	if got.Preferred != 0 || len(got.Ranked) == 0 || len(got.Opponents) != 3 {
		t.Fatal("missing full analysis")
	}
	if _, e := json.Marshal(got); e != nil {
		t.Fatal(e)
	}
}
func TestTemporarySafetyLifecycle(t *testing.T) {
	in := fixture(t)
	in.Snapshot.Phase = "wait_response"
	in.Events = []Action{{Type: "dahai", Actor: 3, Pai: "4p"}}
	_, p, _ := safety(in)
	if p[1][12] {
		t.Fatal("unresolved discard marked safe")
	}
	in.Events = append(in.Events, Action{Type: "tsumo", Actor: 0, Pai: "9p"})
	in.Snapshot.Phase = "wait_act"
	safe, p, _ := safety(in)
	if !p[1][12] || !safe[1][12] || !safe[3][12] {
		t.Fatal("missed passed window or own discard")
	}
	in.Events = append(in.Events, Action{Type: "tsumo", Actor: 1, Pai: "?"})
	_, p, _ = safety(in)
	if p[1][12] || !p[2][12] {
		t.Fatal("temporary safety expired for wrong seat")
	}
	for _, kind := range []string{"chi", "pon", "daiminkan", "ankan", "kakan", "kita"} {
		in.Events = []Action{{Type: "dahai", Actor: 3, Pai: "4p"}, {Type: kind, Actor: 1}}
		_, p, _ = safety(in)
		if p[1][12] {
			t.Fatalf("%s did not expire temporary safety", kind)
		}
	}
}
func TestRiichiPassedTilesPersist(t *testing.T) {
	in := fixture(t)
	in.Events = []Action{{Type: "reach", Actor: 1}, {Type: "dahai", Actor: 3, Pai: "5pr"}, {Type: "tsumo", Actor: 0}, {Type: "tsumo", Actor: 1}}
	safe, p, _ := safety(in)
	if !safe[1][13] || !p[1][13] {
		t.Fatal("riichi safe tile lost after tsumogiri turn")
	}
}
func TestBaselineSafetyWithoutHistory(t *testing.T) {
	in := fixture(t)
	in.Snapshot.Players[2].River = []Discard{{Tile: "5pr"}}
	safe, p, _ := safety(in)
	if !safe[2][13] || p[2][13] || safe[1][13] {
		t.Fatal("manufactured passed-tile safety")
	}
}
func TestSanmaAndRedDora(t *testing.T) {
	in := fixture(t)
	in.Snapshot.Num = 3
	in.Snapshot.Players = in.Snapshot.Players[:3]
	in.Snapshot.Players[0].Tehai[13] = "5pr"
	in.Snapshot.Players[0].Kita = []string{"N"}
	in.Snapshot.Dora = []string{"4p"}
	for i := 1; i < 8; i++ {
		in.Left[i] = 0
	}
	pi := player(in.Snapshot, 0, in.Left)
	if pi.CountDora() != 3 {
		t.Fatalf("dora/red/kita mismatch: %d", pi.CountDora())
	}
	if _, e := json.Marshal(risks(in)); e != nil {
		t.Fatal(e)
	}
}
func TestRedAndPlainShareSafety(t *testing.T) {
	if tile("5pr") != tile("5p") {
		t.Fatal("red safety mismatch")
	}
}

func TestIppatsuExpires(t *testing.T) {
	in := fixture(t)
	in.Events = []Action{{Type: "reach", Actor: 1}, {Type: "dahai", Actor: 1, Pai: "E"}}
	if !ippatsu(in, 1) {
		t.Fatal("first riichi discard must retain ippatsu")
	}
	in.Events = append(in.Events, Action{Type: "pon", Actor: 2})
	if ippatsu(in, 1) {
		t.Fatal("call did not cancel ippatsu")
	}
}
func TestValidSanmaAnalysis(t *testing.T) {
	in := fixture(t)
	in.Snapshot.Num = 3
	in.Snapshot.Players = in.Snapshot.Players[:3]
	hand := []string{"1m", "1m", "1m", "9m", "9m", "9m", "1p", "2p", "3p", "4p", "5p", "6p", "E", "9s"}
	in.Snapshot.Players[0].Tehai = hand
	in.Snapshot.Dora = []string{"1m"}
	for i := range in.Left {
		in.Left[i] = 4
	}
	for i := 1; i < 8; i++ {
		in.Left[i] = 0
	}
	for _, s := range hand {
		in.Left[tile(s)]--
	}
	in.Left[0]--
	in.Actions = []Action{{Type: "dahai", Actor: 0, Pai: "9s"}}
	out := analyze(in)
	if !out.ReferenceOnly || out.Candidates[0] == nil || out.Candidates[0].Shanten != 0 || len(out.Opponents) != 2 {
		t.Fatal("sanma adapter mismatch")
	}
}

func TestLastWallDoesNotCertifyTemporarySafety(t *testing.T) {
	in := fixture(t)
	for i := 0; i < 68; i++ {
		in.Events = append(in.Events, Action{Type: "tsumo", Actor: 0})
	}
	in.Events = append(in.Events, Action{Type: "dahai", Actor: 3, Pai: "4p"}, Action{Type: "tsumo", Actor: 0})
	safe, p, _ := safety(in)
	if p[1][12] || safe[1][12] {
		t.Fatal("temporary ron safety cannot assume unchanged yaku at houtei")
	}
	if !safe[3][12] {
		t.Fatal("own genbutsu must remain")
	}
}
