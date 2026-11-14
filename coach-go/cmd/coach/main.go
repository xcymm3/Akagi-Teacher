// Akagi Teacher adapter. Analysis only: never emits an action to the game.
package main

import (
	"encoding/json"
	"fmt"
	"github.com/EndlessCheng/mahjong-helper/util"
	"github.com/EndlessCheng/mahjong-helper/util/model"
	"io"
	"math"
	"os"
	"sort"
)

type Discard struct {
	Riichi  bool `json:"is_riichi"`
	Tile    string
	Tedashi bool
}
type Meld struct {
	Kind       string
	Tiles      []string
	FromWho    int    `json:"from_who"`
	CalledTile string `json:"called_tile"`
}
type Player struct {
	Seat   int
	Tehai  []string
	Melds  []Meld
	River  []Discard
	Riichi bool     `json:"riichi_declared"`
	Double bool     `json:"double_riichi"`
	Kita   []string `json:"kita_tiles"`
}
type Snapshot struct {
	Seat    *int `json:"our_seat"`
	Num     int  `json:"num_players"`
	Players []Player
	Oya     int
	Bakaze  string
	Dora    []string `json:"dora_markers"`
	Phase   string
}
type Action struct {
	Type     string
	Actor    int
	Pai      string
	Consumed []string
}
type Input struct {
	RiskOnly bool `json:"risk_only"`
	Snapshot Snapshot
	Actions  []Action
	Events   []Action
	Left     []int `json:"left"`
}
type Metrics struct {
	Shanten      int      `json:"shanten"`
	Ukeire       int      `json:"ukeire"`
	Next         float64  `json:"next"`
	Improve      float64  `json:"improve"`
	ImproveTiles []int    `json:"improve_tiles"`
	Speed        float64  `json:"speed"`
	Win          float64  `json:"win"`
	Dama         float64  `json:"dama"`
	Riichi       float64  `json:"riichi"`
	Round        float64  `json:"round"`
	Furiten      float64  `json:"furiten"`
	Yaku         []string `json:"yaku"`
	Part         bool     `json:"part"`
}
type Row struct {
	Tile     int     `json:"tile"`
	Consumed []int   `json:"consumed,omitempty"`
	Metrics  Metrics `json:"metrics"`
}
type Opponent struct {
	Riichi bool      `json:"riichi"`
	Seat   int       `json:"seat"`
	Tenpai float64   `json:"tenpai"`
	Loss   float64   `json:"loss"`
	Risk   []float64 `json:"risk"`
	Safe   []bool    `json:"safe"`
	Passed []bool    `json:"passed"`
}
type Output struct {
	Preferred int `json:"preferred_index"`

	Version       string     `json:"version"`
	Ranked        []Row      `json:"ranked"`
	Candidates    []*Metrics `json:"candidates"`
	Followup      []int      `json:"followup"`
	Opponents     []Opponent `json:"opponents"`
	ReferenceOnly bool       `json:"reference_only"`
}

func tile(s string) int {
	for i, t := range []string{"E", "S", "W", "N", "P", "F", "C"} {
		if s == t {
			return 27 + i
		}
	}
	if len(s) < 2 {
		return -1
	}
	suit := map[byte]int{'m': 0, 'p': 1, 's': 2}
	v, ok := suit[s[1]]
	if !ok || s[0] < '1' || s[0] > '9' {
		return -1
	}
	return v*9 + int(s[0]-'1')
}
func red(s string) bool          { return len(s) > 2 && s[len(s)-1] == 'r' }
func wind(seat, oya, np int) int { return 27 + (seat-oya+np)%np }
func finite(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}
func metrics(r *util.Hand13AnalysisResult) Metrics {
	m := Metrics{r.Shanten, r.Waits.AllCount(), finite(r.AvgNextShantenWaitsCount), finite(r.AvgImproveWaitsCount), []int{}, finite(r.MixedWaitsScore), finite(r.AvgAgariRate), finite(r.DamaPoint), finite(r.RiichiPoint), finite(r.MixedRoundPoint), finite(r.FuritenRate), []string{}, r.IsPartWait}
	for t := range r.Improves {
		m.ImproveTiles = append(m.ImproveTiles, t)
	}
	sort.Ints(m.ImproveTiles)
	for y := range r.YakuTypes {
		m.Yaku = append(m.Yaku, util.YakuTypesWithDoraToStr(map[int]struct{}{y: {}}, 0))
	}
	sort.Strings(m.Yaku)
	return m
}
func player(s Snapshot, seat int, left []int) *model.PlayerInfo {
	p := s.Players[seat]
	pi := &model.PlayerInfo{HandTiles34: make([]int, 34), LeftTiles34: append([]int{}, left...), NumRedFives: make([]int, 3), RoundWindTile: tile(s.Bakaze), SelfWindTile: wind(seat, s.Oya, s.Num), IsParent: seat == s.Oya, IsRiichi: p.Riichi, IsDaburii: p.Double, NukiDoraNum: len(p.Kita)}
	for _, t := range p.Tehai {
		i := tile(t)
		if i < 0 {
			panic("invalid hand")
		}
		pi.HandTiles34[i]++
		if red(t) {
			pi.NumRedFives[i/9]++
		}
	}
	for _, d := range p.River {
		t := tile(d.Tile)
		if t >= 0 {
			if !d.Tedashi {
				t = -(t + 1)
			}
			pi.DiscardTiles = append(pi.DiscardTiles, t)
		}
	}
	for _, d := range s.Dora {
		t := tile(d)
		if t >= 0 {
			pi.DoraTiles = append(pi.DoraTiles, model.DoraTile(t, s.Num == 3))
		}
	}
	for _, m := range p.Melds {
		v := model.Meld{MeldType: map[string]int{"chi": 0, "pon": 1, "ankan": 2, "daiminkan": 3, "kakan": 4}[m.Kind], CalledTile: tile(m.CalledTile)}
		for _, t := range m.Tiles {
			i := tile(t)
			if i < 0 {
				panic("invalid meld")
			}
			v.Tiles = append(v.Tiles, i)
			if red(t) {
				pi.NumRedFives[i/9]++
			}
		}
		pi.Melds = append(pi.Melds, v)
	}
	return pi
}

// Completed discard windows only. A newly presented response tile is not yet
// marked passed. Draws, calls and replacement draws expire temporary safety.
func safety(in Input) ([][]bool, [][]bool, [][]int) {
	np := in.Snapshot.Num
	own := make([][]bool, np)
	passed := make([][]bool, np)
	declared := make([]bool, np)
	meldAt := make([][]int, np)
	riverN := make([]int, np)
	for i := 0; i < np; i++ {
		own[i] = make([]bool, 34)
		passed[i] = make([]bool, 34)
	}
	draws := 0
	var pending *Action
	complete := func() {
		if pending == nil {
			return
		}
		t := tile(pending.Pai)
		if t >= 0 {
			for i := 0; i < np; i++ {
				if i != pending.Actor {
					passed[i][t] = true
				}
			}
		}
		pending = nil
	}
	for _, e := range in.Events {
		a := e.Actor
		if e.Type == "hora" || e.Type == "end_kyoku" {
			pending = nil
			continue
		}
		complete()
		if a < 0 || a >= np {
			continue
		}
		switch e.Type {
		case "reach", "reach_accepted":
			declared[a] = true
		case "tsumo", "chi", "pon", "daiminkan", "ankan", "kakan", "kita":
			if e.Type == "tsumo" {
				draws++
			}
			if !declared[a] {
				passed[a] = make([]bool, 34)
			}
			if e.Type == "chi" || e.Type == "pon" || e.Type == "daiminkan" || e.Type == "ankan" {
				meldAt[a] = append(meldAt[a], riverN[a])
			}
		case "dahai":
			if !declared[a] {
				passed[a] = make([]bool, 34)
			}
			t := tile(e.Pai)
			if t >= 0 {
				own[a][t] = true
			}
			riverN[a]++
			v := e
			pending = &v
		}
	}
	// In wait_act the latest discard window has necessarily closed.
	if in.Snapshot.Phase == "wait_act" {
		complete()
	}
	for i, p := range in.Snapshot.Players {
		for _, d := range p.River {
			t := tile(d.Tile)
			if t >= 0 {
				own[i][t] = true
			}
		}
	}
	// Near haitei/houtei, a previously yaku-less wait can become a legal ron
	// without a hand change. Do not certify temporary safety for closed/non-riichi seats.
	liveDraws := 70
	if np == 3 {
		liveDraws = 55
	}
	if draws >= liveDraws-1 {
		for i := 0; i < np; i++ {
			if !declared[i] {
				passed[i] = make([]bool, 34)
			}
		}
	}
	safe := make([][]bool, np)
	for i := 0; i < np; i++ {
		safe[i] = make([]bool, 34)
		for t := 0; t < 34; t++ {
			safe[i][t] = own[i][t] || passed[i][t]
		}
	}
	return safe, passed, meldAt
}
func ippatsu(in Input, seat int) bool {
	active := false
	cuts := 0
	for _, e := range in.Events {
		if e.Type == "reach" && e.Actor == seat {
			active = true
			cuts = 0
			continue
		}
		if !active {
			continue
		}
		switch e.Type {
		case "chi", "pon", "daiminkan", "ankan", "kakan", "kita":
			active = false
		case "dahai":
			if e.Actor == seat {
				cuts++
				if cuts > 1 {
					active = false
				}
			}
		}
	}
	return active
}
func risks(in Input) []Opponent {
	s := in.Snapshot
	seat := *s.Seat
	for _, d := range s.Dora {
		if tile(d) < 0 {
			panic("invalid dora")
		}
	}
	safe, passed, meldAt := safety(in)
	out := []Opponent{}
	for a, p := range s.Players {
		if a == seat {
			continue
		}
		ds := []int{}
		for _, d := range p.River {
			t := tile(d.Tile)
			if !d.Tedashi {
				t = -(t + 1)
			}
			ds = append(ds, t)
		}
		ms := []*model.Meld{}
		visibleDora := 0
		for _, m := range p.Melds {
			v := &model.Meld{MeldType: map[string]int{"chi": 0, "pon": 1, "ankan": 2, "daiminkan": 3, "kakan": 4}[m.Kind]}
			for _, x := range m.Tiles {
				t := tile(x)
				v.Tiles = append(v.Tiles, t)
				if red(x) {
					visibleDora++
				}
				for _, ind := range s.Dora {
					if model.DoraTile(tile(ind), s.Num == 3) == t {
						visibleDora++
					}
				}
			}
			ms = append(ms, v)
		}
		rate := util.CalcTenpaiRate(ms, ds, meldAt[a])
		if s.Num == 3 {
			rate = util.GetTenpaiRate3(rate)
		}
		loss := util.RonPointDama
		isOpen := false
		for _, m := range ms {
			if m.MeldType != model.MeldTypeAnkan {
				isOpen = true
			}
		}
		if isOpen {
			loss = util.RonPointOtherNakiWithDora(visibleDora)
		}
		if p.Riichi {
			rate = 100
			loss = util.RonPointRiichiHiIppatsu
			if ippatsu(in, a) {
				loss = util.RonPointRiichiIppatsu
			}
		}
		if a == s.Oya {
			loss *= 1.5
		}
		turns := len(p.River)
		if turns < 1 {
			turns = 1
		}
		if turns > util.MaxTurns {
			turns = util.MaxTurns
		}
		dora := []int{}
		for _, ind := range s.Dora {
			dora = append(dora, model.DoraTile(tile(ind), s.Num == 3))
		}
		r := util.CalculateRiskTiles34(turns, safe[a], in.Left, dora, tile(s.Bakaze), wind(a, s.Oya, s.Num))
		early := []int{}
		for i, d := range p.River {
			if i >= 5 || d.Riichi {
				break
			}
			if t := tile(d.Tile); t >= 0 {
				early = append(early, util.OutsideTiles(t)...)
			}
		}
		r = r.FixWithEarlyOutside(early).FixWithPoint(loss)
		values := make([]float64, 34)
		for t := 0; t < 34; t++ {
			values[t] = finite(r[t])
		}
		out = append(out, Opponent{p.Riichi, a, finite(rate), loss, values, safe[a], passed[a]})
	}
	return out
}
func rows(rs util.Hand14AnalysisResultList) []Row {
	out := []Row{}
	for _, r := range rs {
		out = append(out, Row{r.DiscardTile, r.OpenTiles, metrics(r.Result13)})
	}
	return out
}
func analyze(in Input) Output {
	s := in.Snapshot
	if s.Seat == nil || s.Num < 3 || s.Num > 4 || len(s.Players) != s.Num || len(in.Left) != 34 || len(in.Actions) > 3 {
		panic("invalid request")
	}
	seat := *s.Seat
	for _, d := range s.Dora {
		if tile(d) < 0 {
			panic("invalid dora")
		}
	}
	if seat < 0 || seat >= s.Num {
		panic("invalid seat")
	}
	for _, n := range in.Left {
		if n < 0 || n > 4 {
			panic("invalid remaining count")
		}
	}
	out := Output{Version: "mahjong-helper@514bb97+akagi", Ranked: []Row{}, Candidates: make([]*Metrics, len(in.Actions)), Followup: make([]int, len(in.Actions)), ReferenceOnly: s.Num == 3}
	for i := range out.Followup {
		out.Followup[i] = -1
	}
	out.Preferred = -1
	out.Opponents = risks(in)
	if in.RiskOnly {
		return out
	}
	evaluated := map[int]*util.Hand14AnalysisResult{}
	pi := player(s, seat, in.Left)
	count := util.CountOfTiles34(pi.HandTiles34)
	coreRows := util.Hand14AnalysisResultList{}
	if count%3 == 2 {
		_, rs, back := util.CalculateShantenWithImproves14(pi)
		coreRows = append(rs, back...)
		out.Ranked = rows(coreRows)
	}
	for i, a := range in.Actions {
		p := player(s, seat, in.Left)
		t := tile(a.Pai)
		if (a.Type == "dahai" || a.Type == "reach") && t >= 0 && p.HandTiles34[t] > 0 && count%3 == 2 {
			p.DiscardTile(t, red(a.Pai))
			if a.Type == "reach" {
				p.IsRiichi = true
			}
			r := util.CalculateShantenWithImproves13(p)
			m := metrics(r)
			out.Candidates[i] = &m
			row := &util.Hand14AnalysisResult{DiscardTile: t, Result13: r}
			for _, original := range coreRows {
				if original.DiscardTile == t {
					copy := *original
					copy.Result13 = r
					row = &copy
					break
				}
			}
			if red(a.Pai) && t >= 0 {
				row.IsDiscardDoraTile = true
				row.DiscardTileValue += 10000
			}
			if a.Type == "none" {
				row.DiscardTile = -1
			}
			evaluated[i] = row
		} else if (a.Type == "chi" || a.Type == "pon") && t >= 0 && len(a.Consumed) == 2 && count%3 == 1 {
			_, rs, _ := util.CalculateMeld(p, t, red(a.Pai), a.Type == "chi")
			want := []int{tile(a.Consumed[0]), tile(a.Consumed[1])}
			sort.Ints(want)
			for _, r := range rs {
				got := append([]int{}, r.OpenTiles...)
				sort.Ints(got)
				if len(got) == 2 && got[0] == want[0] && got[1] == want[1] {
					m := metrics(r.Result13)
					out.Candidates[i] = &m
					out.Followup[i] = r.DiscardTile
					evaluated[i] = r
					break
				}
			}
		} else if a.Type == "none" && count%3 == 1 {
			r := util.CalculateShantenWithImproves13(p)
			m := metrics(r)
			out.Candidates[i] = &m
			row := &util.Hand14AnalysisResult{DiscardTile: t, Result13: r}
			for _, original := range coreRows {
				if original.DiscardTile == t {
					copy := *original
					copy.Result13 = r
					row = &copy
					break
				}
			}
			if red(a.Pai) && t >= 0 {
				row.IsDiscardDoraTile = true
				row.DiscardTileValue += 10000
			}
			if a.Type == "none" {
				row.DiscardTile = -1
			}
			evaluated[i] = row
		}
	}
	minShanten := 99
	for _, r := range evaluated {
		if r.Result13.Shanten < minShanten {
			minShanten = r.Result13.Shanten
		}
	}
	ranked := util.Hand14AnalysisResultList{}
	// Stable input order before the upstream comparator handles exact ties.
	for i := range in.Actions {
		if r, ok := evaluated[i]; ok && r.Result13.Shanten == minShanten {
			ranked = append(ranked, r)
		}
	}
	ranked.Sort(false)
	if len(ranked) > 0 {
		best := ranked[0]
		if minShanten == 1 && len(pi.DiscardTiles) < 9 && !pi.IsNaki() && best.Result13.Waits.AllCount() < 9 {
			for i := range in.Actions {
				if r, ok := evaluated[i]; ok && r.Result13.Shanten == 2 && r.Result13.MixedWaitsScore > best.Result13.MixedWaitsScore {
					best = r
				}
			}
		}
		for i, r := range evaluated {
			if r == best {
				out.Preferred = i
			}
		}
	}
	return out
}
func run() (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("analysis: %v", r)
		}
	}()
	var in Input
	if e := json.NewDecoder(io.LimitReader(os.Stdin, 2<<20)).Decode(&in); e != nil {
		return e
	}
	return json.NewEncoder(os.Stdout).Encode(analyze(in))
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
