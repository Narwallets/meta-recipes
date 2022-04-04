import * as React from "react"
import { Grid, Button, Icon, Box } from "@mui/material"
import RecipesLogo from "../public/logo.svg"
import { NavLink } from "react-router-dom"
export default function Header() {
    return (
        <Grid
            sx={{
                m: 4,
                position: "absolute",
                left: 0,
                right: 0,
                zIndex: 1
            }}
        >
            <header>
                <NavLink to={"/"}>
                    <img src={RecipesLogo} alt=""></img>
                </NavLink>
                <Box className="back" component="span" justifyContent="flex-end">
                    <Button
                        variant="outlined"
                        sx={{
                            borderRadius: "100px",
                            float: "right",
                            textTransform: "capitalize"
                        }}
                        href="https://metapool.app/"
                        startIcon={<Icon>arrow_back_ios</Icon>}
                    >
                        Back to Meta Pool
                    </Button>
                </Box>
            </header>
        </Grid>
    )
}
